import { randomUUID } from 'crypto'
import { quote } from './deployment-validation'

export interface ContainerInspection {
  Id: string
  Name: string
  Image: string
  Config: Record<string, any>
  HostConfig: Record<string, any>
  Mounts?: Array<{ Type: string; Name?: string; Source: string; Destination: string; RW: boolean }>
  NetworkSettings?: { Networks?: Record<string, Record<string, any>> }
  State: { Running: boolean; Paused?: boolean }
}
export function containerUpdatePlan(container: ContainerInspection): { name: string; image: string; payload: Record<string, any> } {
  const name = container.Name.replace(/^\//, '')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || !/^[a-f0-9]{12,64}$/.test(container.Id)) throw new Error('容器标识不正确')
  const image = /^sha256:/.test(container.Config.Image || '') ? container.Config.Labels?.['project-hub.source-image'] || container.Config.Image : container.Config.Image
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image) || /^sha256:/.test(image) || image.includes('@') || /^[a-f0-9]{12,64}$/.test(image)) throw new Error('此容器使用固定镜像 ID 或摘要，请使用带标签的镜像重新部署')
  const host = structuredClone(container.HostConfig)
  if (host.AutoRemove || container.Config.Labels?.['com.docker.swarm.service.id'] || ['NetworkMode', 'PidMode', 'IpcMode'].some(key => String(host[key] || '').startsWith('container:')) || host.VolumesFrom?.length || host.Links?.length) throw new Error('此容器使用自动删除、Swarm 或容器依赖，请通过原编排配置更新')
  const networks: Record<string, any> = {}
  for (const [network, endpoint] of Object.entries(container.NetworkSettings?.Networks || {})) {
    if (endpoint.IPAMConfig?.IPv4Address || endpoint.IPAMConfig?.IPv6Address) throw new Error('固定 IP 容器请通过原编排配置更新，以避免地址冲突')
    if (!['bridge', 'host', 'none'].includes(network)) networks[network] = { Aliases: (endpoint.Aliases || []).filter((alias: string) => alias !== container.Id && alias !== container.Id.slice(0, 12)), ...(endpoint.DriverOpts ? { DriverOpts: endpoint.DriverOpts } : {}) }
  }
  // Pin existing anonymous volumes as named mounts; never create fresh empty data volumes.
  const mounts = host.Mounts || []
  const binds = [...(host.Binds || [])]
  for (const mount of container.Mounts || []) {
    if (mount.Type !== 'volume' || mounts.some((item: any) => item.Target === mount.Destination) || binds.some(bind => bind.split(':')[1] === mount.Destination)) continue
    if (!mount.Name) throw new Error('无法确认数据卷名称，已停止更新')
    mounts.push({ Type: 'volume', Source: mount.Name, Target: mount.Destination, ReadOnly: !mount.RW })
  }
  host.Mounts = mounts
  const config = structuredClone(container.Config)
  // Do not copy the automatically generated hostname from the old container.
  if (config.Hostname === container.Id.slice(0, 12)) delete config.Hostname
  return { name, image, payload: { ...config, HostConfig: host, NetworkingConfig: { EndpointsConfig: networks } } }
}
export function containerUpdateOperation(container: ContainerInspection, registry?: { server: string; username: string; password: string }): { script: string; input: string } {
  const plan = containerUpdatePlan(container)
  const backup = `${plan.name}-hub-backup-${randomUUID().slice(0, 8)}`
  const payload: Record<string, any> = { ...plan.payload, Labels: { ...plan.payload.Labels, 'project-hub.update-token': backup, 'project-hub.source-image': plan.image } }
  delete payload.Image
  const script = `set -Eeuo pipefail
command -v curl >/dev/null || { echo '服务器需要安装 curl 才能保留配置重建容器'; exit 1; }
# Verify the CLI and socket address the same daemon before modifying any container.
curl -fsS --unix-socket /var/run/docker.sock http://localhost/containers/${container.Id}/json >/dev/null || { echo '无法通过默认 Docker socket 访问目标容器，未修改容器；rootless 或远程 Docker 请使用原部署配置更新'; exit 1; }
name=${quote(plan.name)}
old=${quote(container.Id)}
backup=${quote(backup)}
renamed=0
changed=0
config_dir=''
cleanup() { if [ -n "$config_dir" ]; then rm -rf "$config_dir"; fi; }
rollback() {
  result=$?
  trap - ERR
  echo '更新失败，尝试恢复旧容器'
  if [ "$renamed" = 1 ] && [ "$(docker inspect --format '{{index .Config.Labels "project-hub.update-token"}}' "$name" 2>/dev/null || true)" = "$backup" ]; then docker rm -f "$name" || { echo 'ROLLBACK FAILED: 新容器无法移除'; exit 1; }; fi
  if [ "$renamed" = 1 ]; then docker rename "$backup" "$name" || { echo 'ROLLBACK FAILED: 旧容器重命名失败'; exit 1; }; fi
  if [ "$changed" = 1 ]; then
    ${container.State.Running ? 'docker start "$old" || { echo \'ROLLBACK FAILED: 旧容器启动失败\'; exit 1; }' : ':'}
    ${container.State.Paused ? 'docker pause "$old" || { echo \'ROLLBACK FAILED: 暂停状态恢复失败\'; exit 1; }' : ':'}
  fi
  echo '旧容器已恢复；数据卷未删除'
  exit "$result"
}
trap cleanup EXIT
trap rollback ERR
${registry ? `config_dir=$(mktemp -d)
export DOCKER_CONFIG="$config_dir"
IFS= read -r registry_password
printf '%s\\n' "$registry_password" | docker login ${quote(registry.server)} -u ${quote(registry.username)} --password-stdin
unset registry_password` : ''}
payload=$(cat)
echo '正在拉取 ${plan.image}'
docker pull ${quote(plan.image)}
new_image=$(docker image inspect --format '{{.Id}}' ${quote(plan.image)})
if [ "$new_image" = ${quote(container.Image)} ]; then echo '当前容器已经使用最新镜像，无需重建'; exit 0; fi
# Resolve the tag before stopping the old container; the payload is sent through stdin.
changed=1
${container.State.Paused ? 'docker unpause "$old"' : ':'}
${container.State.Running ? 'docker stop "$old"' : ':'}
docker rename "$old" "$backup"
renamed=1
# Pin the immutable image ID and pass the saved configuration through stdin.
printf '{"Image":"%s",%s' "$new_image" "$payload" | curl -fsS --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X POST --data-binary @- "http://localhost/containers/create?name=$name" >/dev/null
docker start "$name"
for attempt in $(seq 1 60); do
  state=$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")
  case "$state" in
    'true healthy') break ;;
    'true none') sleep 3; test "$(docker inspect --format '{{.State.Running}}' "$name")" = true; break ;;
    'true starting') sleep 2 ;;
    *) echo "新容器状态异常: $state"; false ;;
  esac
  if [ "$attempt" = 60 ]; then echo '新容器健康检查超时'; false; fi
done
test "$(docker inspect --format '{{.Image}}' "$name")" = "$new_image"
trap - ERR
echo '新容器已启动，更新完成'
# Keep volumes; remove only the stopped backup container.
docker rm "$backup" || echo "旧容器清理失败，可手动清理: $backup"
`
  return { script, input: (registry ? registry.password + '\n' : '') + JSON.stringify(payload).slice(1) }
}

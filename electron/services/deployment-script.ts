import type { DeployConfig } from '../../src/types/deployment'
import { quote, validateConfig, registryServer } from './deployment-validation'

export function portOverride(config: DeployConfig): string {
  validateConfig(config)
  if (config.portMappings === undefined) return ''
  const ports = config.portMappings.map(p => `${p.hostIp}:${p.hostPort}:${p.containerPort}/${p.protocol}`)
  return `services:\n  ${config.service}:\n    ports: !override ${JSON.stringify(ports)}\n`
}

export function deployScript(config: DeployConfig, server: string, username: string, image: string): string {
  validateConfig(config); registryServer(server)
  const override = portOverride(config)
  return `set -Eeuo pipefail
cd ${quote(config.remoteDir)}
command -v flock >/dev/null
exec 9>.project-hub-${config.composeProject}.lock
flock -w 300 9
docker info >/dev/null
docker compose version
test -f ${quote(config.composeFile)}
docker_config=$(mktemp -d)
chmod 700 "$docker_config"
trap 'rm -rf -- "$docker_config"' EXIT
export DOCKER_CONFIG="$docker_config"
docker login ${quote(server)} --username ${quote(username)} --password-stdin
export APP_IMAGE=${quote(image)}
previous_override=${quote('.project-hub-' + config.composeProject + '-ports.yaml')}
override_file=''
${override ? `override_file="$docker_config/ports.yaml"
printf '%s' ${quote(override)} > "$override_file"` : ''}
compose() {
  if [ -n "$override_file" ]; then
    docker compose -p ${quote(config.composeProject)} -f ${quote(config.composeFile)} -f "$override_file" "$@"
  else
    docker compose -p ${quote(config.composeProject)} -f ${quote(config.composeFile)} "$@"
  fi
}
if ! compose config --quiet; then
  echo 'Compose 配置校验失败；自定义端口映射需要 Docker Compose 2.24.4 或更新版本'; exit 1
fi
if ! compose config --images ${quote(config.service)} | grep -Fx -- "$APP_IMAGE" >/dev/null; then
  echo 'Compose app image must use APP_IMAGE'; exit 1
fi
ids=$(compose ps -a -q ${quote(config.service)})
count=$(printf '%s\\n' "$ids" | sed '/^$/d' | wc -l)
if [ "$count" -gt 1 ]; then echo 'Only one application replica is supported'; exit 1; fi
old_image=''
if [ -n "$ids" ]; then old_image=$(docker inspect --format '{{.Image}}' "$ids"); fi
docker pull "$APP_IMAGE"
expected=$(docker image inspect --format '{{.Id}}' "$APP_IMAGE")
rollback() {
  echo 'Deployment failed'
  if [ -n "$old_image" ]; then
    export APP_IMAGE="$old_image"
    override_file=''
    if [ -f "$previous_override" ]; then override_file="$previous_override"; fi
    if compose up -d --no-deps --no-build --pull never --wait --wait-timeout 120 ${quote(config.service)}; then
      restored_id=$(compose ps -q ${quote(config.service)})
      restored_image=$(docker inspect --format '{{.Image}}' "$restored_id")
      if [ "$restored_image" = "$old_image" ]; then echo 'Previous image restored';
      else echo 'ROLLBACK FAILED: previous image was not restored'; fi
    else echo 'ROLLBACK FAILED: inspect server manually'; fi
  else echo 'First deployment has no previous version'; fi
  exit 1
}
if ! compose up -d --no-deps --no-build --pull never --wait --wait-timeout 120 ${quote(config.service)}; then rollback; fi
id=$(compose ps -q ${quote(config.service)})
if [ -z "$id" ]; then rollback; fi
actual=$(docker inspect --format '{{.Image}}' "$id")
if [ "$actual" != "$expected" ]; then echo 'Compose app image must use APP_IMAGE'; rollback; fi
health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id")
if [ "$health" != 'healthy' ]; then echo 'A working healthcheck is required'; rollback; fi
printf '%s\\n' ${quote(image)} > .project-hub-${config.composeProject}-current.tmp
mv .project-hub-${config.composeProject}-current.tmp .project-hub-${config.composeProject}-current
${override ? `cp -- "$override_file" "$previous_override.tmp"
mv -- "$previous_override.tmp" "$previous_override"` : 'rm -f -- "$previous_override"'}
echo 'Deployment healthy'
`
}

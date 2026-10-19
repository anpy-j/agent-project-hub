import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProjectModules } from '../electron/services/project-modules'

test('finds nested projects and generates Gradle module tasks from the shared root wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-modules-'))
  try {
    const file = (path: string, content = '') => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content) }
    file('personal-gradle/build.gradle')
    file('personal-gradle/settings.gradle', "include 'gateway'\n")
    file('personal-gradle/gradlew')
    file('personal-gradle/gateway/build.gradle', "plugins { id 'org.springframework.boot' }\n")
    file('personal-gradle/gateway/Dockerfile', 'FROM scratch')
    file('apps/web/package.json', '{"dependencies":{"vue":"*"}}')
    file('node_modules/ignored/package.json', '{}')
    file('apps/web/node_modules/ignored/package.json', '{}')
    if (process.platform !== 'win32') symlinkSync(root, join(root, 'loop'), 'dir')
    const modules = discoverProjectModules(root)
    assert.deepEqual(modules.map(module => module.directory), ['apps/web', 'personal-gradle', 'personal-gradle/gateway'])
    const gradle = modules.find(module => module.directory === 'personal-gradle')!
    assert.equal(gradle.target.directory, 'personal-gradle')
    assert.deepEqual(gradle.dockerfiles, ['personal-gradle/gateway/Dockerfile'])
    const gateway = modules.find(module => module.directory.endsWith('/gateway'))!
    assert.equal(gateway.target.directory, 'personal-gradle')
    assert.match(gateway.target.commands[0], /:gateway:clean :gateway:build -x test/)
    assert.deepEqual(gateway.target.artifactPaths, ['gateway/build/libs'])
    assert.equal(gateway.framework, 'spring-boot')
    const web = modules.find(module => module.directory === 'apps/web')!
    assert.equal(web.target.directory, 'apps/web')
    assert.deepEqual(web.target.commands, ['npm run build'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

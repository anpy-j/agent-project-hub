import type { SkillHistory, SkillInstallation, SkillPackage } from '../../src/types/skills'

export interface SkillsStore {
  packages(): SkillPackage[]
  savePackage(value: SkillPackage): void
  removePackage(id: string): void
  installations(): SkillInstallation[]
  saveInstallation(value: SkillInstallation): void
  removeInstallation(id: string): void
  history(skillId: string): SkillHistory[]
  log(value: SkillHistory): void
}

// A separate store makes filesystem/installation logic testable without starting Electron.
export class MemorySkillsStore implements SkillsStore {
  private skills = new Map<string, SkillPackage>()
  private installs = new Map<string, SkillInstallation>()
  private events: SkillHistory[] = []
  packages() { return structuredClone([...this.skills.values()]) }
  savePackage(value: SkillPackage) { this.skills.set(value.id, structuredClone(value)) }
  removePackage(id: string) { this.skills.delete(id) }
  installations() { return structuredClone([...this.installs.values()]) }
  saveInstallation(value: SkillInstallation) { this.installs.set(value.id, structuredClone(value)) }
  removeInstallation(id: string) { this.installs.delete(id) }
  history(skillId: string) { return structuredClone(this.events.filter(e => e.skillId === skillId).reverse()) }
  log(value: SkillHistory) { this.events.push(structuredClone(value)) }
}

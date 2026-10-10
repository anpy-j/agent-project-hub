import { readdirSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { DiskDriveInfo } from '../../src/types'

function getVolumeGroup(path: string): { id: string; writable: boolean } | undefined {
  try {
    const info = execFileSync('/usr/sbin/diskutil', ['info', '-plist', path], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
    })
    const id = info.match(/<key>APFSVolumeGroupID<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
    if (!id) return undefined
    return { id, writable: /<key>WritableVolume<\/key>\s*<true\s*\/>/.test(info) }
  } catch {
    // Keep the volume visible when metadata is unavailable.
    return undefined
  }
}

/** Enumerate mounted macOS volumes, excluding aliases and ordinary directories. */
export function getMacDiskDrives(): DiskDriveInfo[] {
  const drives: DiskDriveInfo[] = []
  const groups = new Map<string, { index: number; writable: boolean }>()
  const addDrive = (path: string, label: string): void => {
    try {
      const stat = statfsSync(path)
      const total = stat.blocks * stat.bsize
      if (total <= 0) return
      const free = Math.max(0, Math.min(total, stat.bavail * stat.bsize))
      const used = total - free
      const drive: DiskDriveInfo = {
        drive: path, label, totalBytes: total, usedBytes: used, freeBytes: free,
        usedPercent: Math.round(used / total * 100),
        totalGb: Math.round(total / 1024 ** 3 * 10) / 10,
        freeGb: Math.round(free / 1024 ** 3 * 10) / 10
      }
      const group = getVolumeGroup(path)
      const existing = group && groups.get(group.id)
      if (group && existing) {
        // System/Data pairs share capacity. Prefer the writable data volume.
        if (group.writable && !existing.writable) {
          drives[existing.index] = drive
          existing.writable = true
        }
        return
      }
      if (group) groups.set(group.id, { index: drives.length, writable: group.writable })
      drives.push(drive)
    } catch {
      // A disconnected or inaccessible volume must not hide the remaining drives.
    }
  }

  addDrive('/', '系统盘')
  try {
    const parentDevice = statSync('/Volumes').dev
    for (const entry of readdirSync('/Volumes', { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join('/Volumes', entry.name)
      try {
        if (statSync(path).dev === parentDevice) continue
        addDrive(path, entry.name)
      } catch {
        // Volumes can disappear between enumeration and inspection.
      }
    }
  } catch {
    // The system drive is still available when /Volumes cannot be read.
  }
  return drives
}

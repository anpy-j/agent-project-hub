/** Local calendar date, matching the date displayed in the application. */
export function releaseDate(date = new Date()): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}
export function imageProjectName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').replace(/[._-]{2,}/g, '-')
}
export function repositoryNamespaces(repositories: string[]): string[] {
  return [...new Set(repositories.filter(path => path.includes('/')).map(path => path.slice(0, path.lastIndexOf('/'))))].sort()
}

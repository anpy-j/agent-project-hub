export interface RagflowConfig { baseUrl: string; datasetId: string; hasApiKey: boolean }
export interface RagflowInput { baseUrl: string; datasetId: string; apiKey?: string }
export interface RagflowDataset { id: string; name: string }
export interface RagflowDocument { id: string; name: string; run: string; progress: number }
export interface RagflowAPI {
  getConfig(): Promise<RagflowConfig>
  saveConfig(input: RagflowInput): Promise<RagflowConfig>
  test(input: RagflowInput): Promise<{ datasets: RagflowDataset[]; selected: RagflowDataset | null }>
  documents(): Promise<RagflowDocument[]>
  open(): Promise<void>
}

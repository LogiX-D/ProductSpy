export interface ProductVideo {
  url: string;
  thumbnail?: string;
}

export interface ProductAnalysis {
  summary: string;
  sellingPoints: string[];
  targetAudience: string[];
  purchaseMotivations: string[];
  painPoints: string[];
  strengths: string[];
  weaknesses: string[];
  marketingAngles: string[];
  hooks: string[];
  shortVideoScript: string;
  imagePrompts: string[];
  videoPrompts: string[];
}

export type AnalysisField = keyof ProductAnalysis;
export interface AnalysisOptions {
  market: 'US' | 'UK' | 'EU' | 'JP';
  language: 'zh-CN' | 'en' | 'ja';
  platform: 'TikTok' | 'Reels' | 'Shorts';
  style: 'professional' | 'casual' | 'humorous' | 'recommendation';
  duration: 15 | 30 | 60;
  goal: 'awareness' | 'consideration' | 'conversion';
  customInstructions: string;
}
export interface AnalysisPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}
export interface AnalysisEvidence {
  facts: string[];
  inferences: string[];
  unknowns: string[];
  reviewTextAnalyzed: false;
}
export interface GenerationTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}
export interface AIGenerationResult {
  analysis: ProductAnalysis;
  evidence: AnalysisEvidence;
  usage?: GenerationTokenUsage;
}
export interface AnalysisUsage extends GenerationTokenUsage {
  costUsd?: number;
  costEstimated: boolean;
  pricing?: AnalysisPricing;
}
export interface AnalysisMetadata {
  mode: 'mock' | 'real' | 'legacy';
  model?: string;
  options: AnalysisOptions;
  generatedAt: string;
  sourceUpdatedAt: string;
  evidence: AnalysisEvidence;
  usage?: AnalysisUsage;
  requestId?: string;
  selectedFields?: AnalysisField[];
}
export interface AnalysisVersion {
  id: string;
  createdAt: string;
  kind: 'legacy' | 'generated' | 'edited' | 'restored';
  analysis: ProductAnalysis;
  metadata?: AnalysisMetadata;
  parentVersionId?: string;
  restoredFrom?: string;
}
export interface AnalysisSaveContext {
  kind?: AnalysisVersion['kind'];
  metadata?: AnalysisMetadata;
  restoredFrom?: string;
  selectedFields?: AnalysisField[];
}
export interface AnalysisUsageRecord {
  id: string;
  requestId: string;
  productId: string;
  createdAt: string;
  completedAt?: string;
  mode: 'mock' | 'real';
  model?: string;
  status: 'started' | 'succeeded' | 'failed' | 'conflict';
  options: AnalysisOptions;
  fields?: AnalysisField[];
  usage?: AnalysisUsage;
  error?: string;
}
export interface AnalysisUsageReport {
  records: AnalysisUsageRecord[];
  totals: {
    requests: number;
    realRequests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    unknownTokenRequests: number;
    unknownCostRequests: number;
  };
  limits: {
    dailyLimit: number;
    dailyRealRequests: number;
    maxConcurrent: number;
    cooldownUntil?: string;
  };
}
export interface AnalysisGenerationResponse {
  product: Product;
  analysis: ProductAnalysis;
  metadata: AnalysisMetadata;
  requestId: string;
  replayed: boolean;
}

export interface Product {
  id: string;
  source: 'amazon';
  sourceId: string;
  url: string;
  title: string;
  price?: string;
  currency?: string;
  brand?: string;
  rating?: number;
  reviewCount?: number;
  mainImage?: string;
  images: string[];
  videos: ProductVideo[];
  bulletPoints: string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
  aiAnalysis?: ProductAnalysis;
  analysisMetadata?: AnalysisMetadata;
  analysisHistory?: AnalysisVersion[];
  groupIds?: string[];
  tagIds?: string[];
}

export interface LibraryDefinition {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}
export interface LibrarySnapshot {
  products: Product[];
  groups: LibraryDefinition[];
  tags: LibraryDefinition[];
  revision?: string;
}
export interface LibraryDefinitionRequest {
  kind: 'group' | 'tag';
  action: 'create' | 'rename' | 'delete';
  id?: string;
  name?: string;
  color?: string;
  confirmed?: boolean;
}
export interface LibraryBatchRequest {
  ids: string[];
  operation: 'add-tags' | 'remove-tags' | 'add-groups' | 'remove-groups' | 'move-group' | 'delete';
  tagIds?: string[];
  groupIds?: string[];
  expectedUpdatedAt?: Record<string, string>;
  confirmed?: boolean;
}
export interface LibraryBatchResult {
  succeededIds: string[];
  failures: { id: string; error: string }[];
  products?: Product[];
}

export type ProductDraft = Omit<
  Product,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'aiAnalysis'
  | 'analysisMetadata'
  | 'analysisHistory'
  | 'groupIds'
  | 'tagIds'
>;

export interface ProductRepository {
  list(): Promise<Product[]>;
  get(id: string): Promise<Product | undefined>;
  upsert(draft: ProductDraft): Promise<Product>;
  delete(id: string): Promise<void>;
  saveAnalysis(
    id: string,
    analysis: ProductAnalysis,
    expectedUpdatedAt?: string,
    context?: AnalysisSaveContext,
  ): Promise<Product>;
}

export type ProductStorageAdapter = ProductRepository;
export interface ProductSyncAdapter {
  save(draft: ProductDraft): Promise<Product>;
}

export interface AIProvider {
  analyze(product: Product, options?: AnalysisOptions): Promise<ProductAnalysis>;
  generate?(product: Product, options?: AnalysisOptions): Promise<AIGenerationResult>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

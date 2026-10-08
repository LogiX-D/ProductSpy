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
}

export type ProductDraft = Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'aiAnalysis'>;

export interface ProductRepository {
  list(): Promise<Product[]>;
  get(id: string): Promise<Product | undefined>;
  upsert(draft: ProductDraft): Promise<Product>;
  delete(id: string): Promise<void>;
  saveAnalysis(id: string, analysis: ProductAnalysis, expectedUpdatedAt?: string): Promise<Product>;
}

export type ProductStorageAdapter = ProductRepository;
export interface ProductSyncAdapter {
  save(draft: ProductDraft): Promise<Product>;
}

export interface AIProvider {
  analyze(product: Product): Promise<ProductAnalysis>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

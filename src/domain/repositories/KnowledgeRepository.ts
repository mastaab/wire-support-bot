/**
 * Storage of the document index for first-level help: documents identified by their path in the
 * ingested directory, each with its excerpts (chunks) and their embeddings.
 */

/** A stored document without its chunks, as the ingestion compares it. */
export interface KnowledgeDocumentRecord {
  id: string;
  sourcePath: string;
  title: string;
  /** sha256 of the document's text, hex. */
  contentHash: string;
  /** The model that embedded its chunks. */
  embeddingModel: string;
  ingestedAt: Date;
}

/** One excerpt of a document to store, with its embedding. */
export interface NewKnowledgeChunk {
  /** 0-based order within the document. */
  position: number;
  /** The headings above the excerpt below the document title, joined with " > "; empty when there are none. */
  headingPath: string;
  content: string;
  embedding: Float32Array;
}

/** A document to store, replacing any stored one with the same source path. */
export interface NewKnowledgeDocument {
  sourcePath: string;
  title: string;
  contentHash: string;
  embeddingModel: string;
  ingestedAt: Date;
  chunks: NewKnowledgeChunk[];
}

/** A stored chunk with its document's title and ingest time, as the search loads it. */
export interface StoredKnowledgeChunk {
  documentId: string;
  title: string;
  position: number;
  headingPath: string;
  content: string;
  embedding: Float32Array;
  ingestedAt: Date;
}

/**
 * A cheap fingerprint of the stored index: it changes whenever a document is added, replaced or
 * removed, since a replaced document gets a new ingest time and a removal lowers the counts.
 */
export interface KnowledgeVersion {
  documents: number;
  chunks: number;
  latestIngestedAt: Date | null;
}

export interface KnowledgeRepository {
  /** Every stored document, without chunks. */
  listDocuments(): Promise<KnowledgeDocumentRecord[]>;
  /** Stores a document and its chunks in one transaction, replacing a stored one with the same source path. */
  replaceDocument(document: NewKnowledgeDocument): Promise<KnowledgeDocumentRecord>;
  /** Removes the documents with these source paths and their chunks; returns how many were removed. */
  deleteDocuments(sourcePaths: readonly string[]): Promise<number>;
  version(): Promise<KnowledgeVersion>;
  /**
   * Every chunk embedded with `embeddingModel`, and the number of chunks embedded with any other
   * model (which a search with this model cannot use).
   */
  loadChunks(embeddingModel: string): Promise<{ chunks: StoredKnowledgeChunk[]; otherModelChunks: number }>;
}

/** Joins a heading path's headings for display and storage. */
export const HEADING_PATH_SEPARATOR = " > ";

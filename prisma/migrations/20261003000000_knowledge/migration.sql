-- The document index for first-level help: plain tables, no database extension. Embeddings are bytea (float32, little-endian), searched in memory.

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" TEXT NOT NULL,
    "source_path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "ingested_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "heading_path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" BYTEA NOT NULL,
    "dimension" INTEGER NOT NULL,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_source_path_key" ON "knowledge_documents"("source_path");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_document_id_position_key" ON "knowledge_chunks"("document_id", "position");

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;


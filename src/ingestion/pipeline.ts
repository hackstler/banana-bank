import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { config } from '../config';
import type { Chunk, DocumentRecord } from '../types';
import { chunkDocument } from './chunker';
import { embedTexts, dimensions } from '../retrieval/embeddings';
import { replaceChunks, exportIndex } from '../retrieval/store';
import { errorDetails, traceLog } from '../trace';
export function documents(): DocumentRecord[] {
  return JSON.parse(fs.readFileSync(path.resolve('fixtures/documents/manifest.json'), 'utf8'));
}
export function readDocument(doc: DocumentRecord) {
  const root = path.resolve('fixtures/documents');
  const filename = path.resolve(root, doc.file);
  if (!filename.startsWith(root + path.sep)) throw new Error('Invalid document path.');
  let text = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.html'))
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  return text.replace(/\r\n/g, '\n');
}
export async function ingest(
  onProgress: (value: string) => void = () => {},
  trace: Record<string, unknown> = {},
) {
  const ingestionId = randomUUID(),
    started = Date.now();
  traceLog('rag', 'ingestion.started', {
    ...trace,
    ingestionId,
    model: config.embeddingModel,
    dimensions,
  });
  try {
    const docs = documents();
    traceLog('rag', 'ingestion.manifest.loaded', {
      ...trace,
      ingestionId,
      documents: docs.length,
    });
    const chunks: Chunk[] = docs.flatMap((doc) => {
      const text = readDocument(doc);
      traceLog('rag', 'ingestion.document.loaded', {
        ...trace,
        ingestionId,
        documentId: doc.id,
        file: doc.file,
        version: doc.version,
        audience: doc.audience,
        characters: text.length,
      });
      const documentChunks = chunkDocument(doc, text);
      traceLog('rag', 'ingestion.document.chunked', {
        ...trace,
        ingestionId,
        documentId: doc.id,
        chunks: documentChunks.length,
      });
      return documentChunks;
    });
    onProgress(`${docs.length} documents · ${chunks.length} chunks`);
    traceLog('rag', 'ingestion.embeddings.started', {
      ...trace,
      ingestionId,
      chunks: chunks.length,
    });
    const vectors = await embedTexts(
      chunks.map((c) => c.text),
      { ...trace, ingestionId, origin: 'ingestion' },
    );
    const complete = chunks.map((c, i) => ({ ...c, vector: vectors[i] }));
    traceLog('rag', 'ingestion.index.replace.started', {
      ...trace,
      ingestionId,
      chunks: complete.length,
    });
    replaceChunks(complete, { model: config.embeddingModel, dimensions });
    onProgress('Index updated.');
    const result = {
      ingestionId,
      documents: docs.length,
      chunks: complete.length,
      model: config.embeddingModel,
      dimensions,
    };
    traceLog('rag', 'ingestion.completed', {
      ...trace,
      ...result,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    traceLog('rag', 'ingestion.failed', {
      ...trace,
      ingestionId,
      durationMs: Date.now() - started,
      error: errorDetails(error),
    });
    throw error;
  }
}
export function saveInitialIndex() {
  fs.mkdirSync('fixtures/embeddings', { recursive: true });
  fs.writeFileSync('fixtures/embeddings/index.json.gz', gzipSync(JSON.stringify(exportIndex())));
}

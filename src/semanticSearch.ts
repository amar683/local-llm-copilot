import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ServerController } from './serverController';

export interface ChunkData {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding?: number[];
}

interface IndexData {
  version: number;
  updatedAt: number;
  chunks: ChunkData[];
}

export class SemanticSearch {
  private static getIndexFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.vscode', 'local-llm-index.json');
  }

  /**
   * Split a file's content into overlapping chunks.
   * Uses configuration settings for chunkSize and chunkOverlap.
   */
  private static chunkText(text: string, maxChars: number, overlapChars: number): { text: string; startLine: number; endLine: number }[] {
    const chunks: { text: string; startLine: number; endLine: number }[] = [];
    const lines = text.split('\n');
    
    let currentChunk = '';
    let currentChunkStartLine = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (currentChunk.length + line.length > maxChars && currentChunk.length > 0) {
        // Save the current chunk
        chunks.push({
          text: currentChunk,
          startLine: currentChunkStartLine,
          endLine: i
        });
        
        // Backtrack to create overlap
        let backtrackLen = 0;
        let backtrackLines = 0;
        for (let j = i - 1; j >= currentChunkStartLine - 1; j--) {
          if (backtrackLen + lines[j].length > overlapChars) break;
          backtrackLen += lines[j].length + 1; // +1 for newline
          backtrackLines++;
        }
        
        i = i - backtrackLines;
        currentChunk = '';
        currentChunkStartLine = i + 1;
      } else {
        currentChunk += line + '\n';
      }
    }
    
    if (currentChunk.trim().length > 0) {
      chunks.push({
        text: currentChunk,
        startLine: currentChunkStartLine,
        endLine: lines.length
      });
    }

    return chunks;
  }

  /**
   * Reads all workspace files (excluding binaries/node_modules) and indexes them.
   */
  public static async indexWorkspace(
    serverController: ServerController,
    port: number,
    onProgress: (msg: string) => void
  ): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder open.");
    }
    const root = workspaceFolders[0].uri.fsPath;
    
    // Ensure .vscode exists
    const vscodeDir = path.join(root, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }

    onProgress('Scanning workspace files...');
    
    const config = vscode.workspace.getConfiguration('localLlm.semanticSearch');
    const chunkSize = config.get<number>('chunkSize') || 1000;
    const chunkOverlap = config.get<number>('chunkOverlap') || 200;

    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,.vscode,dist,build,out,bin,obj}/**'
    );

    const validExts = new Set(['.ts', '.js', '.py', '.cpp', '.c', '.h', '.hpp', '.java', '.go', '.rs', '.cs', '.md', '.json', '.html', '.css']);
    const textFiles = files.filter(f => validExts.has(path.extname(f.fsPath).toLowerCase()));

    onProgress(`Found ${textFiles.length} text files. Chunking...`);

    const allChunks: ChunkData[] = [];
    
    for (const file of textFiles) {
      try {
        const content = await fs.promises.readFile(file.fsPath, 'utf8');
        const relativePath = vscode.workspace.asRelativePath(file, false);
        const fileChunks = this.chunkText(content, chunkSize, chunkOverlap);
        
        for (const c of fileChunks) {
          allChunks.push({
            file: relativePath,
            startLine: c.startLine,
            endLine: c.endLine,
            text: c.text
          });
        }
      } catch (e) {
        // Skip unreadable files
      }
    }

    onProgress(`Generated ${allChunks.length} chunks. Requesting embeddings (this may take a while)...`);

    // Batch process embeddings to avoid timeout
    const batchSize = 20;
    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batch = allChunks.slice(i, i + batchSize);
      const texts = batch.map(c => `File: ${c.file}\n\n${c.text}`);
      
      onProgress(`Embedding chunks ${i + 1} to ${Math.min(i + batchSize, allChunks.length)} of ${allChunks.length}...`);
      
      try {
        const embeddings = await serverController.embedText(port, texts);
        for (let j = 0; j < batch.length; j++) {
          batch[j].embedding = embeddings[j];
        }
      } catch (e) {
        throw new Error(`Failed to generate embeddings: ${e}`);
      }
    }

    onProgress('Saving index...');
    const indexData: IndexData = {
      version: 1,
      updatedAt: Date.now(),
      chunks: allChunks
    };

    const indexPath = this.getIndexFilePath(root);
    await fs.promises.writeFile(indexPath, JSON.stringify(indexData));
    
    onProgress('Indexing complete!');
  }

  private static cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Search the index for the query.
   */
  public static async search(
    serverController: ServerController,
    port: number,
    query: string,
    topK: number = 5
  ): Promise<ChunkData[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder open.");
    }
    const root = workspaceFolders[0].uri.fsPath;
    const indexPath = this.getIndexFilePath(root);

    if (!fs.existsSync(indexPath)) {
      throw new Error("Index not found. Please index the codebase first.");
    }

    const indexContent = await fs.promises.readFile(indexPath, 'utf8');
    let indexData: IndexData;
    try {
      indexData = JSON.parse(indexContent);
    } catch {
      throw new Error("Corrupted index file.");
    }

    // Embed query
    const queryEmbeddings = await serverController.embedText(port, [query]);
    if (!queryEmbeddings || queryEmbeddings.length === 0) {
      throw new Error("Failed to embed query.");
    }
    const queryVec = queryEmbeddings[0];

    // Calculate similarities
    const results = indexData.chunks.map(chunk => {
      if (!chunk.embedding) return { chunk, score: -1 };
      return {
        chunk,
        score: this.cosineSimilarity(queryVec, chunk.embedding)
      };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK).map(r => r.chunk);
  }
}

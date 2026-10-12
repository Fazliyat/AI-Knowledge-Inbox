import db from "../database/database.js";

const insertChunkStatement = db.prepare(`
    INSERT INTO chunks (item_id, chunk_index, content, embedding, metadata)
    VALUES (?, ?, ?, ?, ?)
`);

const deleteItemChunksStatement = db.prepare(`
    DELETE FROM chunks WHERE item_id = ?
`);

const getItemChunksStatement = db.prepare(`
    SELECT id, item_id, chunk_index, content, embedding, metadata
    FROM chunks
    WHERE item_id = ?
    ORDER BY chunk_index ASC
`);

const getAllActiveChunksStatement = db.prepare(`
    SELECT c.id, c.item_id, c.chunk_index, c.content, c.embedding, c.metadata,
           i.title, i.source_type, i.source_url
    FROM chunks c
    JOIN items i ON i.id = c.item_id
    WHERE i.trashed_at IS NULL
    ORDER BY c.item_id DESC, c.chunk_index ASC
`);

const getItemsNeedingChunkingStatement = db.prepare(`
    SELECT i.id, i.title, i.content, i.source_type, i.source_url, d.extracted_text
    FROM items i
    LEFT JOIN documents d ON d.item_id = i.id
    WHERE i.trashed_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM chunks c WHERE c.item_id = i.id
      )
    ORDER BY i.id ASC
`);

/**
 * Saves chunk records for an item in a single transaction.
 * Replaces any existing chunks for that item.
 *
 * @param {number} itemId
 * @param {Array<{ chunkIndex: number, content: string, embedding: number[], metadata: object }>} chunks
 * @returns {number} Count of saved chunks
 */
export function saveItemChunks(itemId, chunks) {
    if (!itemId || !Array.isArray(chunks) || chunks.length === 0) {
        return 0;
    }

    const transaction = db.transaction(() => {
        deleteItemChunksStatement.run(itemId);
        let insertedCount = 0;
        for (const chunk of chunks) {
            const embeddingJson = chunk.embedding ? JSON.stringify(chunk.embedding) : null;
            const metadataJson = chunk.metadata ? JSON.stringify(chunk.metadata) : null;
            insertChunkStatement.run(
                itemId,
                chunk.chunkIndex ?? 0,
                chunk.content,
                embeddingJson,
                metadataJson
            );
            insertedCount += 1;
        }
        return insertedCount;
    });

    return transaction();
}

/**
 * Deletes all chunks for an item.
 *
 * @param {number} itemId
 */
export function deleteItemChunks(itemId) {
    return deleteItemChunksStatement.run(itemId);
}

/**
 * Retrieves all chunks for an item.
 *
 * @param {number} itemId
 * @returns {Array<object>}
 */
export function getItemChunks(itemId) {
    const rows = getItemChunksStatement.all(itemId);
    return rows.map((row) => ({
        ...row,
        embedding: row.embedding ? JSON.parse(row.embedding) : null,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
}

/**
 * Retrieves all chunks from active (non-trashed) items.
 *
 * @returns {Array<object>}
 */
export function getAllActiveChunks() {
    const rows = getAllActiveChunksStatement.all();
    return rows.map((row) => {
        let parsedMetadata = null;
        try {
            parsedMetadata = row.metadata ? JSON.parse(row.metadata) : null;
        } catch {
            parsedMetadata = null;
        }

        let parsedEmbedding = null;
        try {
            parsedEmbedding = row.embedding ? JSON.parse(row.embedding) : null;
        } catch {
            parsedEmbedding = null;
        }

        return {
            id: row.id,
            itemId: row.item_id,
            chunkIndex: row.chunk_index,
            content: row.content,
            embedding: parsedEmbedding,
            metadata: {
                itemId: row.item_id,
                title: row.title,
                sourceType: row.source_type,
                sourceUrl: row.source_url,
                ...parsedMetadata,
            },
        };
    });
}

/**
 * Retrieves active items that currently do not have any chunks stored.
 *
 * @returns {Array<object>}
 */
export function getItemsNeedingChunking() {
    return getItemsNeedingChunkingStatement.all();
}

/**
 * Returns total chunk count.
 *
 * @returns {number}
 */
export function getChunkCount() {
    return db.prepare("SELECT count(*) as count FROM chunks").get()?.count ?? 0;
}

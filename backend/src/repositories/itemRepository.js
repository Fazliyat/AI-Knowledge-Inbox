import db from "../database/database.js";

const createItemStatement = db.prepare(`
    INSERT INTO items (
        title,
        content,
        source_type,
        source_url,
        favorite,
        created_at,
        updated_at,
        last_accessed_at
    )
    VALUES (?, ?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const getAllItemsStatement = db.prepare(`
    SELECT
        i.id,
        i.title,
        i.content,
        i.source_type,
        i.source_url,
        i.favorite,
        i.created_at,
        i.updated_at,
        i.last_accessed_at,
        d.file_id,
        d.file_name AS original_file_name,
        d.file_type,
        d.mime_type,
        d.file_size,
        d.storage_path AS storage_location,
        d.processing_status,
        COALESCE(d.uploaded_at, d.created_at) AS uploaded_at
    FROM items i
    LEFT JOIN documents d ON d.item_id = i.id
    WHERE i.trashed_at IS NULL
    ORDER BY i.id DESC
`);

const deleteItemStatement = db.prepare(`
    UPDATE items SET
        trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND trashed_at IS NULL
`);
const deleteTypedItemStatement = db.prepare(`
    UPDATE items SET
        trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND source_type = ? AND trashed_at IS NULL
`);
const restoreItemStatement = db.prepare(`
    UPDATE items SET trashed_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND trashed_at IS NOT NULL
`);
const permanentlyDeleteItemStatement = db.prepare(`
    DELETE FROM items WHERE id = ? AND trashed_at IS NOT NULL
`);
const toggleFavoriteStatement = db.prepare(`
    UPDATE items
    SET favorite = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND trashed_at IS NULL
`);
const updateItemStatement = db.prepare(`
    UPDATE items
    SET title = ?, content = ?, source_type = ?, source_url = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND trashed_at IS NULL
`);

const getItemByIdStatement = db.prepare(`
    SELECT i.id, i.title, i.content, i.source_type, i.source_url, i.favorite,
           i.created_at, i.updated_at, i.last_accessed_at, d.file_id,
           d.file_name AS original_file_name, d.file_type, d.mime_type, d.file_size,
           d.storage_path AS storage_location, d.processing_status,
           COALESCE(d.uploaded_at, d.created_at) AS uploaded_at
    FROM items i
    LEFT JOIN documents d ON d.item_id = i.id
    WHERE i.id = ? AND i.trashed_at IS NULL
`);

export function createItem(item) {
    const result = createItemStatement.run(
        item.title,
        item.content,
        item.sourceType,
        item.sourceUrl ?? null
    );

    return getItemByIdStatement.get(result.lastInsertRowid);
}

export function getAllItems() {
    return getAllItemsStatement.all();
}

export function findRagCandidates(terms) {
    const keywords = [...new Set(terms)].slice(0, 20);
    if (keywords.length === 0) return [];

    const clauses = keywords.map(() => "(title LIKE ? OR content LIKE ? OR source_url LIKE ?)").join(" OR ");
    const params = keywords.flatMap((term) => {
        const pattern = `%${term}%`;
        return [pattern, pattern, pattern];
    });
    return db.prepare(`
        SELECT id, title, content, source_type, source_url
        FROM items
        WHERE trashed_at IS NULL
          AND source_type IN ('note', 'document', 'url')
          AND (length(trim(content)) > 0 OR length(trim(source_url)) > 0)
          AND (${clauses})
        ORDER BY datetime(updated_at) DESC
        LIMIT 50
    `).all(...params);
}

export function getFilteredItems(type, searchText) {
    let query = `
        SELECT
            i.id,
            i.title,
            i.content,
            i.source_type,
            i.source_url,
            i.favorite,
            i.created_at,
            i.updated_at,
            i.last_accessed_at,
            d.file_id,
            d.file_name AS original_file_name,
            d.file_type,
            d.mime_type,
            d.file_size,
            d.storage_path AS storage_location,
            d.processing_status,
            COALESCE(d.uploaded_at, d.created_at) AS uploaded_at
        FROM items i
        LEFT JOIN documents d ON d.item_id = i.id
        WHERE i.trashed_at IS NULL
    `;

    const conditions = [];
    const params = [];

    if (type && type !== "all") {
        if (type === "favorites") {
            conditions.push("i.favorite = 1");
        } else if (["note", "url", "document"].includes(type)) {
            conditions.push("i.source_type = ?");
            params.push(type);
        }
    }

    if (searchText && searchText.trim()) {
        conditions.push("(i.title LIKE ? OR i.content LIKE ? OR i.source_url LIKE ?)");
        const value = `%${searchText.trim()}%`;
        params.push(value, value, value);
    }

    if (conditions.length > 0) {
        query += ` AND ${conditions.join(" AND ")}`;
    }

    query += " ORDER BY i.id DESC";

    return db.prepare(query).all(...params);
}

export function getItemById(id) {
    return getItemByIdStatement.get(id);
}

export function deleteItemById(id, sourceType) {
    return sourceType
        ? deleteTypedItemStatement.run(id, sourceType)
        : deleteItemStatement.run(id);
}

export function toggleFavoriteById(id, favoriteValue) {
    const value = favoriteValue ? 1 : 0;
    toggleFavoriteStatement.run(value, id);
    return getItemById(id);
}

export function updateItemById(id, item) {
    const result = updateItemStatement.run(
        item.title,
        item.content,
        item.sourceType,
        item.sourceUrl ?? null,
        id
    );
    if (result.changes && item.sourceType === "document") {
        db.prepare("UPDATE documents SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE item_id = ?").run(item.title, id);
    }
    return result.changes ? getItemById(id) : null;
}

export function getTrashedItems() {
    return db.prepare(`
        SELECT i.id, i.title, i.content, i.source_type, i.source_url, i.favorite,
               i.created_at, i.updated_at, i.trashed_at, d.file_id,
               d.file_name AS original_file_name, d.file_type, d.mime_type, d.file_size,
               d.storage_path AS storage_location, d.processing_status,
               COALESCE(d.uploaded_at, d.created_at) AS uploaded_at
        FROM items i
        LEFT JOIN documents d ON d.item_id = i.id
        WHERE i.trashed_at IS NOT NULL ORDER BY datetime(i.trashed_at) DESC
    `).all();
}

export function restoreItemById(id) {
    const result = restoreItemStatement.run(id);
    return result.changes ? getItemById(id) : null;
}

export function permanentlyDeleteItemById(id) {
    const transaction = db.transaction(() => {
        const result = permanentlyDeleteItemStatement.run(id);
        if (result.changes) {
            db.prepare("DELETE FROM documents WHERE item_id = ?").run(id);
        }
        return result;
    });
    return transaction();
}

export function importTextDocument({ title, fileName, fileType, fileSize, content }) {
    const transaction = db.transaction(() => {
        const result = createItemStatement.run(title, content, "document", null);
        const itemId = Number(result.lastInsertRowid);
        db.prepare(`
            INSERT INTO documents (
                item_id, title, file_name, file_type, file_size, content, status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'processed',
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(itemId, title, fileName, fileType, fileSize, content);
        return getItemByIdStatement.get(itemId);
    });
    return transaction();
}

export function searchKnowledge({ query, type, from, to, sort = "newest", includeTrash = false }) {
    const clauses = [];
    const params = [];

    if (!includeTrash) {
        clauses.push("trashed_at IS NULL");
    } else {
        clauses.push("trashed_at IS NOT NULL");
    }
    if (query) {
        clauses.push("(title LIKE ? OR content LIKE ? OR source_url LIKE ?)");
        const match = `%${query}%`;
        params.push(match, match, match);
    }
    if (type && ["note", "url", "document"].includes(type)) {
        clauses.push("source_type = ?");
        params.push(type);
    }
    if (from) {
        clauses.push("datetime(created_at) >= datetime(?)");
        params.push(from);
    }
    if (to) {
        clauses.push("datetime(created_at) <= datetime(?)");
        params.push(to);
    }

    const order = sort === "oldest" ? "ASC" : "DESC";
    const rows = db.prepare(`
        SELECT id, title, content, source_type, source_url, favorite, created_at,
               updated_at, trashed_at
        FROM items
        WHERE ${clauses.join(" AND ")}
        ORDER BY datetime(created_at) ${order}
        LIMIT 100
    `).all(...params);

    return rows.map((row) => ({ ...row, result_type: row.source_type, result_id: row.id }));
}
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, "../../knowledge.db");
const db = new Database(dbPath);

db.pragma("foreign_keys = ON");

const ensureColumn = (tableName, columnName, columnDefinition) => {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = columns.some((column) => column.name === columnName);

    if (!exists) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
    }
};

db.exec(`
    CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_type TEXT NOT NULL
            CHECK (source_type IN ('note', 'url', 'document')),
        source_url TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_accessed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT,
        metadata TEXT,
        FOREIGN KEY (item_id)
            REFERENCES items(id)
            ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        draft_content TEXT NOT NULL DEFAULT '',
        trashed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (conversation_id)
            REFERENCES conversations(id)
            ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        content TEXT,
        status TEXT NOT NULL DEFAULT 'uploaded',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS note_drafts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'note' CHECK (source_type IN ('note', 'url')),
        source_url TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_item_id
    ON chunks(item_id);
`);

ensureColumn("items", "favorite", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("items", "updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
ensureColumn("items", "last_accessed_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
ensureColumn("items", "trashed_at", "TEXT");
ensureColumn("conversations", "draft_content", "TEXT NOT NULL DEFAULT ''");
ensureColumn("conversations", "trashed_at", "TEXT");
ensureColumn("chat_messages", "sources", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("documents", "item_id", "INTEGER");
ensureColumn("documents", "file_id", "TEXT");
ensureColumn("documents", "mime_type", "TEXT");
ensureColumn("documents", "storage_path", "TEXT");
ensureColumn("documents", "uploaded_at", "TEXT");
ensureColumn("documents", "processing_status", "TEXT");
ensureColumn("documents", "extracted_text", "TEXT");
ensureColumn("chunks", "embedding", "TEXT");
ensureColumn("chunks", "metadata", "TEXT");

const itemsTableSql = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'
`).get()?.sql || "";

if (!itemsTableSql.includes("'document'")) {
    db.pragma("foreign_keys = OFF");
    const migrateItemsSourceTypes = db.transaction(() => {
        db.exec(`
            CREATE TABLE items_migrated (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                source_type TEXT NOT NULL CHECK (source_type IN ('note', 'url', 'document')),
                source_url TEXT,
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                last_accessed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                trashed_at TEXT
            );

            INSERT INTO items_migrated (
                id, title, content, source_type, source_url, favorite,
                created_at, updated_at, last_accessed_at, trashed_at
            )
            SELECT
                id, title, content, source_type, source_url, favorite,
                created_at, updated_at, last_accessed_at, trashed_at
            FROM items;

            DROP TABLE items;
            ALTER TABLE items_migrated RENAME TO items;
        `);
    });
    migrateItemsSourceTypes();
    db.pragma("foreign_keys = ON");
}

const createIndexesStatement = `
    CREATE INDEX IF NOT EXISTS idx_items_source_type
    ON items(source_type);

    CREATE INDEX IF NOT EXISTS idx_items_favorite
    ON items(favorite);

    CREATE INDEX IF NOT EXISTS idx_items_trash
    ON items(trashed_at);

    CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversations_trash
    ON conversations(trashed_at);

    CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
    ON chat_messages(conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_note_drafts_updated
    ON note_drafts(updated_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_file_id
    ON documents(file_id) WHERE file_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_documents_item_id
    ON documents(item_id);
`;

db.exec(createIndexesStatement);

console.log("SQLite database initialized successfully.");

export default db;
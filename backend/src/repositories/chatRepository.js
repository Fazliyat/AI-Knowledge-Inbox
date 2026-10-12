import { randomUUID } from "node:crypto";
import db from "../database/database.js";

const createConversationStatement = db.prepare(`
    INSERT INTO conversations (id, title, draft_content, created_at, updated_at)
    VALUES (?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
`);

const getConversationStatement = db.prepare(`
    SELECT id, title, draft_content, created_at, updated_at
    FROM conversations
    WHERE id = ? AND trashed_at IS NULL
`);

const createMessageStatement = db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, role, content, sources, created_at)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

export function createConversation(title = "New conversation", requestedId, timestamps = {}, draftContent = "") {
    const id = requestedId || randomUUID();
    createConversationStatement.run(
        id,
        title,
        draftContent,
        timestamps.createdAt || null,
        timestamps.updatedAt || null
    );
    return getConversation(id);
}

export function getConversation(id) {
    const conversation = getConversationStatement.get(id);
    if (!conversation) return null;

    const messages = db.prepare(`
        SELECT id, role, content, sources, created_at
        FROM chat_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, rowid ASC
    `).all(id).map((message) => ({
        ...message,
        sources: JSON.parse(message.sources || "[]"),
    }));

    return { ...conversation, messages };
}

export function listConversations() {
    return db.prepare(`
        SELECT id, title, draft_content, created_at, updated_at
        FROM conversations
        WHERE trashed_at IS NULL
        ORDER BY datetime(updated_at) DESC
    `).all().map((conversation) => ({
        ...conversation,
        messages: db.prepare(`
            SELECT id, role, content, sources, created_at
            FROM chat_messages
            WHERE conversation_id = ?
            ORDER BY created_at ASC, rowid ASC
        `).all(conversation.id).map((message) => ({
            ...message,
            sources: JSON.parse(message.sources || "[]"),
        })),
    }));
}

export function saveConversationDraft(id, { title, draftContent }) {
    const result = db.prepare(`
        UPDATE conversations
        SET title = ?, draft_content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND trashed_at IS NULL
    `).run(title, draftContent, id);
    return result.changes ? getConversation(id) : null;
}

export function addChatMessage(id, { role, content, sources = [] }) {
    const conversation = getConversation(id);
    if (!conversation) return null;

    const messageId = randomUUID();
    const title = conversation.messages.length === 0 && role === "user" &&
        conversation.title === "New conversation"
        ? content.slice(0, 60)
        : conversation.title;

    const transaction = db.transaction(() => {
        createMessageStatement.run(messageId, id, role, content, JSON.stringify(sources));
        db.prepare(`
            UPDATE conversations
            SET title = ?, draft_content = '', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
        `).run(title, id);
    });
    transaction();
    return getConversation(id);
}

export function importConversationMessages(id, messages = []) {
    if (!getConversation(id)) return null;
    const transaction = db.transaction(() => {
        const insert = db.prepare(`
            INSERT OR IGNORE INTO chat_messages (id, conversation_id, role, content, sources, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const message of messages) {
            insert.run(
                message.id || randomUUID(),
                id,
                message.role,
                message.content,
                JSON.stringify(Array.isArray(message.sources) ? message.sources : []),
                message.created_at || message.createdAt || new Date().toISOString()
            );
        }
        db.prepare("UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
    });
    transaction();
    return getConversation(id);
}

export function renameConversation(id, title) {
    const result = db.prepare(`
        UPDATE conversations SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND trashed_at IS NULL
    `).run(title, id);
    return result.changes ? getConversation(id) : null;
}

export function trashConversation(id) {
    return db.prepare(`
        UPDATE conversations
        SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND trashed_at IS NULL
    `).run(id);
}

export function listTrashedConversations() {
    return db.prepare(`
        SELECT id, title, created_at, updated_at, trashed_at
        FROM conversations WHERE trashed_at IS NOT NULL
        ORDER BY datetime(trashed_at) DESC
    `).all();
}

export function restoreConversation(id) {
    return db.prepare(`
        UPDATE conversations
        SET trashed_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND trashed_at IS NOT NULL
    `).run(id);
}

export function permanentlyDeleteConversation(id) {
    return db.prepare(`
        DELETE FROM conversations WHERE id = ? AND trashed_at IS NOT NULL
    `).run(id);
}

export function addNoteDraft({ id, title, content, sourceType, sourceUrl }) {
    const draftId = id || randomUUID();
    db.prepare(`
        INSERT INTO note_drafts (id, title, content, source_type, source_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            source_type = excluded.source_type,
            source_url = excluded.source_url,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(draftId, title, content, sourceType, sourceUrl ?? null);
    return getNoteDraft(draftId);
}

export function listNoteDrafts() {
    return db.prepare(`
        SELECT id, title, content, source_type, source_url, created_at, updated_at
        FROM note_drafts ORDER BY datetime(updated_at) DESC
    `).all();
}

export function getNoteDraft(id) {
    return db.prepare(`
        SELECT id, title, content, source_type, source_url, created_at, updated_at
        FROM note_drafts WHERE id = ?
    `).get(id);
}

export function deleteNoteDraft(id) {
    return db.prepare("DELETE FROM note_drafts WHERE id = ?").run(id);
}

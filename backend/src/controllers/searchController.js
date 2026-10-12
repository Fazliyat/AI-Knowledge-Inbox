import db from "../database/database.js";
import { getTrashedItems, searchKnowledge } from "../repositories/itemRepository.js";

function parseDate(value, endOfDay = false) {
    if (value === undefined || value === "") return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return undefined;
    }
    const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
        return undefined;
    }
    return date.toISOString().replace("T", " ").replace("Z", "");
}

function timestampMillis(value) {
    if (typeof value !== "string" || !value) return NaN;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
        ? `${value.replace(" ", "T")}Z`
        : value;
    return Date.parse(normalized);
}

export function search(req, res, next) {
    try {
        const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const type = typeof req.query.type === "string" ? req.query.type : "all";
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to, true);
        const sort = req.query.sort === "oldest" ? "oldest" : "newest";
        const includeTrash = req.query.trash === "true";

        if (query.length > 200) {
            return res.status(400).json({ success: false, message: "Search query must be 200 characters or fewer." });
        }
        if (from === undefined || to === undefined) {
            return res.status(400).json({ success: false, message: "Dates must use YYYY-MM-DD format." });
        }
        if (type !== "all" && !["note", "url", "document", "conversation"].includes(type)) {
            return res.status(400).json({ success: false, message: "Unsupported search type." });
        }

        const activeResults = includeTrash ? [] : searchKnowledge({
            query,
            type: type === "conversation" ? null : type,
            from,
            to,
            sort,
        });
        let trashedResults = [];
        if (includeTrash) {
            trashedResults = getTrashedItems()
                .filter((item) => !query || `${item.title} ${item.content} ${item.source_url || ""}`.toLowerCase().includes(query.toLowerCase()))
                .filter((item) => type === "all" || type === item.source_type)
                .filter((item) => (!from || timestampMillis(item.created_at) >= timestampMillis(from)) &&
                    (!to || timestampMillis(item.created_at) <= timestampMillis(to)))
                .map((item) => ({ ...item, result_type: item.source_type, result_id: item.id }));
        }

        const conversationRows = db.prepare(`
            SELECT c.id, c.title, c.created_at, c.updated_at, c.trashed_at,
                   group_concat(m.content, char(10)) AS content
            FROM conversations c
            LEFT JOIN chat_messages m ON m.conversation_id = c.id
            WHERE c.trashed_at IS ${includeTrash ? "NOT " : ""}NULL
            GROUP BY c.id
        `).all()
            .filter((row) => type === "all" || type === "conversation")
            .filter((row) => !query || `${row.title} ${row.content || ""}`.toLowerCase().includes(query.toLowerCase()))
            .filter((row) => (!from || timestampMillis(row.created_at) >= timestampMillis(from)) &&
                (!to || timestampMillis(row.created_at) <= timestampMillis(to)))
            .map((row) => ({
                id: row.id,
                title: row.title,
                content: row.content || "",
                created_at: row.created_at,
                updated_at: row.updated_at,
                trashed_at: row.trashed_at,
                result_type: "conversation",
                result_id: row.id,
            }));

        const results = [...activeResults, ...trashedResults, ...conversationRows]
            .sort((a, b) => {
                const direction = sort === "oldest" ? 1 : -1;
                return direction * (timestampMillis(a.created_at) - timestampMillis(b.created_at));
            })
            .slice(0, 100);
        return res.json({ success: true, count: results.length, data: results });
    } catch (error) {
        next(error);
    }
}

import {
    addChatMessage,
    createConversation,
    getConversation,
    importConversationMessages,
    listConversations,
    listTrashedConversations,
    permanentlyDeleteConversation,
    renameConversation,
    restoreConversation,
    saveConversationDraft,
    trashConversation,
} from "../repositories/chatRepository.js";
import { getFilteredItems } from "../repositories/itemRepository.js";
import {
    generateAssistantReply,
    retrieveDatabaseKnowledge,
    retrieveSavedLinks,
    searchExternalWebLinks,
    summarizeAssistantContent,
} from "../services/aiService.js";

const MAX_MESSAGE_LENGTH = 8_000;
const MAX_DRAFT_LENGTH = 20_000;
const MAX_ACTION_TOPIC_LENGTH = 500;

function getActionContext(req, res) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(req.params.id)) {
        res.status(400).json({ success: false, message: "Invalid conversation ID." });
        return null;
    }
    const conversation = getConversation(req.params.id);
    if (!conversation) {
        res.status(404).json({ success: false, message: "Conversation not found." });
        return null;
    }
    const { topic } = req.body || {};
    if (topic !== undefined &&
        (typeof topic !== "string" || topic.trim().length > MAX_ACTION_TOPIC_LENGTH)) {
        res.status(400).json({ success: false, message: "Topic must be 500 characters or fewer." });
        return null;
    }
    const explicitTopic = typeof topic === "string" && topic.trim() ? topic.trim() : "";
    const latestQuestion = [...conversation.messages].reverse()
        .find((message) => message.role === "user")?.content || "";
    return {
        conversation,
        explicitTopic,
        topic: explicitTopic || latestQuestion,
    };
}

export async function summarizeConversation(req, res, next) {
    try {
        const context = getActionContext(req, res);
        if (!context) return;

        const assistantAnswers = context.conversation.messages
            .filter((message) => message.role === "assistant")
            .slice(-8)
            .map((message) => message.content.trim())
            .filter(Boolean);

        let notes = [];
        if (context.explicitTopic) {
            notes = retrieveDatabaseKnowledge(context.explicitTopic, 50)
                .filter((source) => source.type === "note")
                .map((source) => ({
                    id: source.id,
                    title: source.title,
                    content: source.content,
                }));
        } else if (context.topic && !assistantAnswers.length) {
            // When a specific query exists without prior assistant answers, check for matching notes
            notes = retrieveDatabaseKnowledge(context.topic, 50)
                .filter((source) => source.type === "note")
                .map((source) => ({
                    id: source.id,
                    title: source.title,
                    content: source.content,
                }));
        } else {
            // When summarizing notes generally or within an existing conversation, retrieve actual saved notes
            notes = getFilteredItems("note", "")
                .filter((note) => typeof note.content === "string" && note.content.trim())
                .slice(0, 25);
        }

        if (!assistantAnswers.length && !notes.length) {
            const answer = context.topic
                ? `I couldn't find assistant answers or saved notes relevant to "${context.topic}". Ask a question first or save a note about this topic, then try again.`
                : "There are no assistant answers or saved notes to summarize yet. Ask a question or save a note, then try again.";
            const conversation = addChatMessage(context.conversation.id, { role: "assistant", content: answer });
            return res.json({ success: true, data: conversation });
        }

        const summary = await summarizeAssistantContent({
            assistantAnswers,
            notes,
            topic: context.explicitTopic || context.topic,
        });
        const conversation = addChatMessage(context.conversation.id, {
            role: "assistant",
            content: summary.answer,
            sources: summary.sources,
        });
        return res.json({ success: true, data: conversation });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        return next(error);
    }
}

export async function findConversationLinks(req, res, next) {
    try {
        const context = getActionContext(req, res);
        if (!context) return;
        if (!context.topic.trim()) {
            return res.status(400).json({
                success: false,
                message: "Ask a question or enter a topic before finding relevant links.",
            });
        }

        const savedLinks = retrieveSavedLinks(context.topic, 10);

        let webLinks = [];
        let webSearchError = "";
        try {
            webLinks = await searchExternalWebLinks(context.topic);
        } catch (error) {
            if (!error.statusCode) return next(error);
            webSearchError = error.message;
        }

        const sources = [...savedLinks, ...webLinks];
        let answer;
        if (webSearchError) {
            answer = savedLinks.length
                ? `Google web search failed: ${webSearchError} I found matching links already saved in your Knowledge Inbox below.`
                : `Google web search failed: ${webSearchError} No matching saved links were found.`;
        } else if (!webLinks.length && !savedLinks.length) {
            answer = `No verified web results or saved links were found for "${context.topic}".`;
        } else {
            const parts = [];
            if (savedLinks.length) parts.push(`Found ${savedLinks.length} matching link${savedLinks.length === 1 ? "" : "s"} already saved in your Knowledge Inbox.`);
            if (webLinks.length) parts.push(`Google Search verified ${webLinks.length} external resource${webLinks.length === 1 ? "" : "s"} for "${context.topic}".`);
            if (!webLinks.length) parts.push("Google Search returned no verified external pages.");
            answer = parts.join(" ");
        }

        const conversation = addChatMessage(context.conversation.id, { role: "assistant", content: answer, sources });
        return res.json({
            success: true,
            data: conversation,
            search: { topic: context.topic, savedCount: savedLinks.length, webCount: webLinks.length, webSearchError: webSearchError || null },
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        return next(error);
    }
}

export function listChats(req, res, next) {
    try {
        return res.json({ success: true, data: listConversations() });
    } catch (error) {
        next(error);
    }
}

export function createChat(req, res, next) {
    try {
        const { title, id, createdAt, updatedAt, draftContent } = req.body;
        if (title !== undefined && (typeof title !== "string" || title.length > 100)) {
            return res.status(400).json({ success: false, message: "Conversation title must be 100 characters or fewer." });
        }
        if (id !== undefined && (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id))) {
            return res.status(400).json({ success: false, message: "Invalid conversation ID." });
        }
        if (draftContent !== undefined &&
            (typeof draftContent !== "string" || draftContent.length > MAX_DRAFT_LENGTH)) {
            return res.status(400).json({ success: false, message: "Conversation draft is too large." });
        }
        for (const timestamp of [createdAt, updatedAt]) {
            if (timestamp !== undefined &&
                (typeof timestamp !== "string" || timestamp.length > 40 || Number.isNaN(Date.parse(timestamp)))) {
                return res.status(400).json({ success: false, message: "Conversation timestamps must be valid date strings." });
            }
        }
        return res.status(201).json({
            success: true,
            data: createConversation(
                title?.trim() || "New conversation",
                id,
                { createdAt, updatedAt },
                draftContent || ""
            ),
        });
    } catch (error) {
        next(error);
    }
}

export function getChat(req, res, next) {
    try {
        const conversation = getConversation(req.params.id);
        if (!conversation) {
            return res.status(404).json({ success: false, message: "Conversation not found." });
        }
        return res.json({ success: true, data: conversation });
    } catch (error) {
        next(error);
    }
}

export function updateChat(req, res, next) {
    try {
        const { title, draftContent } = req.body;
        if (title !== undefined && (typeof title !== "string" || title.trim().length > 100)) {
            return res.status(400).json({ success: false, message: "Conversation title must be 100 characters or fewer." });
        }
        if (draftContent !== undefined &&
            (typeof draftContent !== "string" || draftContent.length > MAX_DRAFT_LENGTH)) {
            return res.status(400).json({ success: false, message: "Conversation draft is too large." });
        }
        const current = getConversation(req.params.id);
        if (!current) {
            return res.status(404).json({ success: false, message: "Conversation not found." });
        }
        const conversation = saveConversationDraft(req.params.id, {
            title: title?.trim() || current.title,
            draftContent: draftContent ?? current.draft_content,
        });
        return res.json({ success: true, data: conversation });
    } catch (error) {
        next(error);
    }
}

export async function sendChatMessage(req, res, next) {
    try {
        const { conversationId, message } = req.body;
        if (typeof conversationId !== "string" || !conversationId.trim()) {
            return res.status(400).json({ success: false, message: "A conversation ID is required." });
        }
        if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
            return res.status(400).json({ success: false, message: "Message must contain 1 to 8,000 characters." });
        }
        const existingChat = getConversation(conversationId);
        if (!existingChat) {
            return res.status(404).json({ success: false, message: "Conversation not found." });
        }

        const userText = message.trim();
        const priorMessages = existingChat.messages || [];
        addChatMessage(conversationId, { role: "user", content: userText });
        const reply = await generateAssistantReply({
            message: userText,
            conversationHistory: priorMessages,
        });
        const conversation = addChatMessage(conversationId, {
            role: "assistant",
            content: reply.answer,
            sources: reply.sources,
        });
        return res.json({ success: true, data: { ...conversation, sources: reply.sources } });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        next(error);
    }
}

export function renameChat(req, res, next) {
    try {
        const { title } = req.body;
        if (typeof title !== "string" || !title.trim() || title.trim().length > 100) {
            return res.status(400).json({ success: false, message: "A title of 1 to 100 characters is required." });
        }
        const conversation = renameConversation(req.params.id, title.trim());
        if (!conversation) return res.status(404).json({ success: false, message: "Conversation not found." });
        return res.json({ success: true, data: conversation });
    } catch (error) {
        next(error);
    }
}

export function importChatHistory(req, res, next) {
    try {
        const { messages } = req.body;
        if (!Array.isArray(messages) || messages.length > 200) {
            return res.status(400).json({ success: false, message: "Conversation history must contain at most 200 messages." });
        }
        const normalized = [];
        for (const message of messages) {
            if (!message || !["user", "assistant"].includes(message.role) ||
                typeof message.content !== "string" || message.content.length > MAX_MESSAGE_LENGTH ||
                (message.id !== undefined && (typeof message.id !== "string" || message.id.length > 100))) {
                return res.status(400).json({ success: false, message: "Invalid message in conversation history." });
            }
            normalized.push(message);
        }
        const conversation = importConversationMessages(req.params.id, normalized);
        if (!conversation) return res.status(404).json({ success: false, message: "Conversation not found." });
        return res.json({ success: true, data: conversation });
    } catch (error) {
        next(error);
    }
}

export function deleteChat(req, res, next) {
    try {
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(req.params.id)) {
            return res.status(400).json({ success: false, message: "Invalid conversation ID." });
        }
        const result = trashConversation(req.params.id);
        if (!result.changes) return res.status(404).json({ success: false, message: "Conversation not found." });
        return res.json({ success: true, message: "Conversation moved to Trash." });
    } catch (error) {
        next(error);
    }
}

export function listChatTrash(req, res, next) {
    try {
        return res.json({ success: true, data: listTrashedConversations() });
    } catch (error) {
        next(error);
    }
}

export function restoreChat(req, res, next) {
    try {
        const result = restoreConversation(req.params.id);
        if (!result.changes) return res.status(404).json({ success: false, message: "Trashed conversation not found." });
        return res.json({ success: true });
    } catch (error) {
        next(error);
    }
}

export function permanentlyDeleteChat(req, res, next) {
    try {
        const result = permanentlyDeleteConversation(req.params.id);
        if (!result.changes) return res.status(404).json({ success: false, message: "Trashed conversation not found." });
        return res.json({ success: true });
    } catch (error) {
        next(error);
    }
}

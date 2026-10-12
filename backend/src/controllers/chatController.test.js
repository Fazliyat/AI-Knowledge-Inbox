import assert from "node:assert/strict";
import { test } from "node:test";
import {
    addChatMessage,
    createConversation,
    permanentlyDeleteConversation,
    trashConversation,
} from "../repositories/chatRepository.js";
import { createItem, deleteItemById, permanentlyDeleteItemById } from "../repositories/itemRepository.js";
import { findConversationLinks, summarizeConversation } from "./chatController.js";

function mockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

test("summary action explains when the selected conversation and saved knowledge have no matching source", async () => {
    const conversation = createConversation("Disposable empty-summary test");
    const uniqueTopic = `unmatched-${Date.now()}-topic`;
    addChatMessage(conversation.id, { role: "user", content: uniqueTopic });
    const response = mockResponse();

    try {
        await summarizeConversation(
            { params: { id: conversation.id }, body: {} },
            response,
            (error) => { throw error; }
        );

        assert.equal(response.statusCode, 200);
        assert.match(response.body.data.messages.at(-1).content, /couldn't find assistant answers or saved notes relevant/i);
        assert.equal(response.body.data.messages.at(-1).role, "assistant");
    } finally {
        trashConversation(conversation.id);
        permanentlyDeleteConversation(conversation.id);
    }
});

test("link action returns matching saved links when Gemini web search is unavailable", async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const item = createItem({
        title: "Disposable React hooks link",
        content: "Official React hooks documentation for state and effects.",
        sourceType: "url",
        sourceUrl: "https://react.dev/reference/react",
    });
    const conversation = createConversation("Disposable saved-link fallback test");
    addChatMessage(conversation.id, { role: "user", content: "Find resources about React hooks." });
    const response = mockResponse();

    try {
        await findConversationLinks(
            { params: { id: conversation.id }, body: {} },
            response,
            (error) => { throw error; }
        );

        assert.equal(response.statusCode, 200);
        assert.equal(response.body.search.savedCount, 1);
        assert.equal(response.body.search.webCount, 0);
        assert.match(response.body.search.webSearchError, /not configured/i);
        const assistant = response.body.data.messages.at(-1);
        assert.match(assistant.content, /Google web search failed/i);
        assert.equal(assistant.sources[0].kind, "saved-link");
        assert.equal(assistant.sources[0].url, "https://react.dev/reference/react");
    } finally {
        trashConversation(conversation.id);
        permanentlyDeleteConversation(conversation.id);
        deleteItemById(item.id, "url");
        permanentlyDeleteItemById(item.id);
        if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
    }
});

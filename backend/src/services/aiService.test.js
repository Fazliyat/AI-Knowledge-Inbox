import assert from "node:assert/strict";
import { test } from "node:test";
import {
    classifyGeminiError,
    cleanAssistantAnswer,
    extractCitationMetadata,
    extractGroundedWebLinks,
    generateAssistantReply,
    isCitationMarker,
    retrieveRelevantKnowledge,
    searchExternalWebLinks,
    stripCitationMarkers,
    summarizeAssistantContent,
} from "./aiService.js";

test("keyword retrieval returns saved knowledge with its true source identity", () => {
    const results = retrieveRelevantKnowledge([
        {
            id: 41,
            title: "JavaScript async notes",
            source_type: "note",
            source_url: null,
            content: "Promises and async functions help manage asynchronous JavaScript code.",
        },
        {
            id: 42,
            title: "Gardening ideas",
            source_type: "note",
            source_url: null,
            content: "Rotate crops between seasons to protect soil health.",
        },
        {
            id: 43,
            title: "Async JavaScript link",
            source_type: "url",
            source_url: "https://example.com",
            content: "A reference to JavaScript promises.",
        },
    ], "How do promises help JavaScript?");

    assert.equal(results.length, 2);
    assert.equal(results[0].id, 41);
    assert.equal(results[0].title, "JavaScript async notes");
    assert.equal(results[0].type, "note");
    assert.equal(results[1].id, 43);
    assert.equal(results[1].title, "Async JavaScript link");
    assert.equal(results[1].type, "url");
});

test("keyword retrieval includes saved links and ranks URL matches", () => {
    const results = retrieveRelevantKnowledge([
        {
            id: 91,
            title: "Node.js documentation",
            source_type: "url",
            source_url: "https://nodejs.org/en/learn",
            content: "",
        },
        {
            id: 92,
            title: "Server-side JavaScript notes",
            source_type: "note",
            content: "Node.js runs JavaScript outside a browser.",
        },
    ], "What is Node.js?");

    assert.deepEqual(results.map((result) => result.id), [91, 92]);
    assert.equal(results[0].type, "url");
    assert.equal(results[0].content, "https://nodejs.org/en/learn");
});

test("external link results are limited to URLs returned in Google Search grounding metadata", () => {
    const links = extractGroundedWebLinks({
        text: JSON.stringify({
            results: [
                { url: "https://react.dev/reference/react/hooks", description: "Official React hooks reference." },
                { url: "https://invented.example/fake", description: "This URL was not grounded." },
            ],
        }),
        candidates: [{
            groundingMetadata: {
                groundingChunks: [
                    { web: { uri: "https://react.dev/reference/react/hooks#overview", title: "Built-in React Hooks" } },
                    { web: { uri: "javascript:alert(1)", title: "Unsafe result" } },
                ],
            },
        }],
    }, "React hooks");

    assert.deepEqual(links, [{
        url: "https://react.dev/reference/react/hooks",
        title: "Built-in React Hooks",
        domain: "react.dev",
        kind: "web-link",
        description: "Official React hooks reference.",
    }]);
});

test("AI requests fail explicitly when the server Gemini key is missing", async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
        await assert.rejects(
            generateAssistantReply({ message: "General question", items: [] }),
            (error) => error.statusCode === 503 && error.message.includes("GEMINI_API_KEY")
        );
    } finally {
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousKey;
    }
});

test("summary and external search requests fail clearly when Gemini is not configured", async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
        await assert.rejects(
            summarizeAssistantContent({
                assistantAnswers: ["A real assistant answer."],
                notes: [],
                topic: "",
            }),
            (error) => error.statusCode === 503 && error.message.includes("GEMINI_API_KEY")
        );
        await assert.rejects(
            searchExternalWebLinks("React hooks"),
            (error) => error.statusCode === 503 && error.message.includes("GEMINI_API_KEY")
        );
    } finally {
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousKey;
    }
});

test("Gemini failures return useful safe messages without forwarding SDK details", () => {
    const cases = [
        [{ status: 403, message: "sensitive credential details" }, 401, /rejected.*API key/i],
        [{ status: 429, message: "quota exhausted" }, 429, /quota or rate limit/i],
        [{ status: 404, message: "unknown model" }, 400, /model is unavailable/i],
        [{ status: 503, message: "This model is currently experiencing high demand." }, 503, /temporarily under high demand/i],
        [{ code: "ENOTFOUND", message: "network failure" }, 503, /network connectivity/i],
    ];

    for (const [cause, statusCode, expectedMessage] of cases) {
        const result = classifyGeminiError(cause);
        assert.equal(result.statusCode, statusCode);
        assert.match(result.message, expectedMessage);
        assert.doesNotMatch(result.message, /sensitive credential details/i);
    }
});

test("cleanAssistantAnswer removes raw [SOURCE id=... title=\"...\"] markers from answer text", () => {
    const raw = 'Your application uses Node.js 24.15.0 [SOURCE id=98 title="Note"].';
    const { answer, citations } = cleanAssistantAnswer(raw);
    assert.equal(answer, "Your application uses Node.js 24.15.0.");
    assert.equal(citations.length, 1);
    assert.equal(citations[0].id, 98);
    assert.equal(citations[0].title, "Note");
});

test("cleanAssistantAnswer handles multiple citations and cleans trailing commas or spaces", () => {
    const raw = 'Based on your saved materials, your application uses **SQLite** for persistent database storage [SOURCE id=98 type=note title="Note"], [SOURCE id=82 type=note title="Note"].';
    const { answer, citations } = cleanAssistantAnswer(raw);
    assert.equal(
        answer,
        "Based on your saved materials, your application uses **SQLite** for persistent database storage."
    );
    assert.equal(citations.length, 2);
    assert.equal(citations[0].id, 98);
    assert.equal(citations[1].id, 82);
});

test("cleanAssistantAnswer handles structured JSON responses and preserves structured sources", () => {
    const rawJson = JSON.stringify({
        answer: 'Your application uses Node.js 24.15.0 and SQLite [SOURCE id=98 title="Note"].',
        sources: [{ id: 98, title: "Note", type: "note" }],
    });
    const { answer, citations, isStructured } = cleanAssistantAnswer(rawJson);
    assert.equal(isStructured, true);
    assert.equal(answer, "Your application uses Node.js 24.15.0 and SQLite.");
    assert.equal(citations.length, 1);
    assert.equal(citations[0].id, 98);
});

test("cleanAssistantAnswer leaves plain answers without citations intact", () => {
    const plain = "This is a direct response with no saved knowledge citations.";
    const { answer, citations } = cleanAssistantAnswer(plain);
    assert.equal(answer, plain);
    assert.equal(citations.length, 0);
});

test("stripCitationMarkers preserves non-citation brackets and code references", () => {
    const textWithBrackets = "Look at items [1, 2, 3] and [SOURCE_CODE] in the project repository.";
    assert.equal(stripCitationMarkers(textWithBrackets), textWithBrackets);
});

test("isCitationMarker identifies citation markers and ignores normal text in brackets", () => {
    assert.equal(isCitationMarker('SOURCE id=98 title="Note"'), true);
    assert.equal(isCitationMarker("SOURCE id=82"), true);
    assert.equal(isCitationMarker("/SOURCE"), true);
    assert.equal(isCitationMarker("1, 2, 3"), false);
    assert.equal(isCitationMarker("SOURCE_CODE"), false);
    assert.equal(isCitationMarker("NOTE: do not forget this"), false);
});

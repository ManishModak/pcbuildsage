process.env.PCBUILDSAGE_SESSIONS_DB_PATH = "/tmp/claude-1000/-home-manishm-Projects-pcbuildsage-workspace/3caa3770-40c4-47bc-aa6e-9c1142c7d7f4/scratchpad/probe-sessions.db";
import { saveSession, getSession, listSessions, deleteSession } from "./src/lib/sessions";
const msgs = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "suggest a build" }] },
  { id: "a1", role: "assistant", parts: [{ type: "reasoning", text: "thinking..." }, { type: "tool-search_products", input: { category: "gpu" }, output: { results: [] } }, { type: "text", text: "here you go" }] }
];
saveSession({ id: "s1", messages: msgs, title: "suggest a build", countryCode: "IN", currency: "INR" });
const before = new Date().toISOString();
saveSession({ id: "s2", messages: [{ id: "u2", role: "user", parts: [{ type: "text", text: "second" }] }], title: "second", countryCode: "IN", currency: "INR" });
// update s1 to bump updated_at so ordering puts it first
saveSession({ id: "s1", messages: msgs, title: "suggest a build (edited)", countryCode: "IN", currency: "INR" });
const got = getSession("s1");
console.log("ROUNDTRIP parts preserved:", JSON.stringify(got?.messages) === JSON.stringify(msgs));
console.log("created_at insert-only kept:", got?.created_at, "title:", got?.title);
console.log("LIST order (expect s1 first, no messages blob):", listSessions().map(s => s.id), "hasMessagesField:", "messages" in (listSessions()[0] as any));
deleteSession("s2");
console.log("after delete:", listSessions().map(s => s.id));
console.log("getSession(missing):", getSession("nope"));

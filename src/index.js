const ROLES = ["student", "teacher", "moderator", "administrator"];
const ADMIN_ROLES = new Set(["administrator"]);
const STAFF_ROLES = new Set(["administrator", "moderator"]);
const SESSION_DAYS = 7;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
const fail = (message, status = 400) => json({ error: message }, status);
const uuid = () => crypto.randomUUID();
const enc = new TextEncoder();
const toHex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
async function digest(value) { return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value))); }
async function passwordHash(password, salt = toHex(crypto.getRandomValues(new Uint8Array(16)))) {
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 310000, hash: "SHA-256" }, material, 256);
  return "pbkdf2-sha256$310000$" + salt + "$" + toHex(bits);
}
async function verifyPassword(password, stored) {
  const [scheme, rounds, salt, expected] = String(stored).split("$");
  if (scheme !== "pbkdf2-sha256" || Number(rounds) !== 310000 || !salt || !expected) return false;
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 310000, hash: "SHA-256" }, material, 256);
  const actual = toHex(bits);
  return actual.length === expected.length && actual === expected;
}
function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  const item = cookies.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}
function cookieHeader(value, maxAge) { return "campusly_session=" + encodeURIComponent(value) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge; }
function isSecureOrigin(request) { const origin = request.headers.get("Origin"); return !origin || origin === new URL(request.url).origin; }
async function body(request) { try { return await request.json(); } catch { return null; } }
async function audit(env, actor, action, target = null, result = "success", details = {}) {
  try { await env.DB.prepare("INSERT INTO audit_logs(actor_id,actor_username,action,target,result,details_json) VALUES(?,?,?,?,?,?)").bind(actor?.id || null, actor?.username || null, action, target ? String(target).slice(0,180) : null, result, JSON.stringify(details).slice(0,2000)).run(); } catch (e) { console.error("audit_write_failed", action, e?.message); }
}
async function currentUser(request, env) {
  const token = cookieValue(request, "campusly_session");
  if (!token) return null;
  const idHash = await digest(token);
  const row = await env.DB.prepare("SELECT u.id,u.username,u.role,u.status,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? LIMIT 1").bind(idHash, new Date().toISOString()).first();
  return row && row.status === "active" ? row : null;
}
function requireRole(user, roles) { return !!user && roles.has(user.role); }
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  return user || null;
}
function id() { return uuid(); }
async function seedAdmin(env) {
  if (!env.ADMIN_USERNAME || !env.CAMPUSLY_BOOTSTRAP_ADMIN_PASSWORD) return;
  const username = String(env.ADMIN_USERNAME).trim();
  const password = String(env.CAMPUSLY_BOOTSTRAP_ADMIN_PASSWORD);
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username) || password.length < 14) {
    console.error("Admin bootstrap skipped: username format or password length policy failed.");
    return;
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
  if (existing) return;
  const hash = await passwordHash(password);
  const userId = id();
  await env.DB.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,'administrator')").bind(userId, username, hash).run();
  await audit(env, { id: userId, username }, "bootstrap_admin_created", username, "success", { source: "environment_secret" });
}
async function handle(request, env) {
  if (!env.DB) return fail("Database binding is missing. Configure the Campusly D1 database.", 503);
  await seedAdmin(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", "vary": "Origin" } });
  if (path.startsWith("/api/") && !isSecureOrigin(request)) return fail("Cross-origin request rejected.", 403);
  if (path === "/api/health" && request.method === "GET") return json({ ok: true, service: "Campusly API" });
  if (path === "/api/auth/login" && request.method === "POST") {
    const data = await body(request);
    if (!data || typeof data.username !== "string" || typeof data.password !== "string" || data.username.length > 64 || data.password.length > 256) return fail("Enter a valid username and password.", 400);
    const user = await env.DB.prepare("SELECT id,username,password_hash,role,status FROM users WHERE username=? COLLATE NOCASE LIMIT 1").bind(data.username.trim()).first();
    if (!user || user.status !== "active" || !(await verifyPassword(data.password, user.password_hash))) {
      await audit(env, user ? { id: user.id, username: user.username } : null, "login_failed", data.username.trim().slice(0,64), "denied", { reason: "invalid_credentials" });
      return fail("Invalid username or password.", 401);
    }
    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await env.DB.prepare("INSERT INTO sessions(id_hash,user_id,expires_at,user_agent) VALUES(?,?,?,?)").bind(await digest(token), user.id, expires, (request.headers.get("User-Agent") || "").slice(0,240)).run();
    await env.DB.prepare("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?").bind(new Date().toISOString(), new Date().toISOString(), user.id).run();
    await audit(env, user, "login_success", user.username);
    return json({ user: { id: user.id, username: user.username, role: user.role } }, 200, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    const user = await currentUser(request, env);
    const token = cookieValue(request, "campusly_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash=?").bind(await digest(token)).run();
    if (user) await audit(env, user, "logout", user.username);
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }
  const user = await requireUser(request, env);
  if (path === "/api/me" && request.method === "GET") return user ? json({ user }) : fail("Authentication required.", 401);
  if (!user) return fail("Authentication required.", 401);
  if (user.status !== "active") return fail("Account is not active.", 403);

  if (path === "/api/channels" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT ch.id,ch.name,ch.description,ch.visibility,ch.class_id,c.name AS class_name FROM channels ch JOIN classes c ON c.id=ch.class_id JOIN class_members cm ON cm.class_id=c.id AND cm.user_id=? WHERE ch.visibility='class' OR EXISTS(SELECT 1 FROM channel_members x WHERE x.channel_id=ch.id AND x.user_id=?) ORDER BY c.name,ch.name LIMIT 300").bind(user.id,user.id).all();
    return json({ channels: rows.results || [] });
  }
  const channelMessages = path.match(/^\/api\/channels\/([^/]+)\/messages$/);
  if (channelMessages) {
    const channelId = decodeURIComponent(channelMessages[1]);
    const member = await env.DB.prepare("SELECT ch.id FROM channels ch JOIN class_members cm ON cm.class_id=ch.class_id AND cm.user_id=? WHERE ch.id=? AND (ch.visibility='class' OR EXISTS(SELECT 1 FROM channel_members x WHERE x.channel_id=ch.id AND x.user_id=?))").bind(user.id,channelId,user.id).first();
    if (!member) return fail("Channel not found or access denied.", 404);
    if (request.method === "GET") {
      const rows = await env.DB.prepare("SELECT m.id,m.content,m.created_at,u.username FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.channel_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 100").bind(channelId).all();
      return json({ messages: (rows.results || []).reverse() });
    }
    if (request.method === "POST") {
      const data = await body(request); const content = typeof data?.content === "string" ? data.content.trim() : "";
      if (!content || content.length > 4000) return fail("Messages must be between 1 and 4000 characters.");
      const messageId = id();
      await env.DB.prepare("INSERT INTO messages(id,channel_id,sender_id,content) VALUES(?,?,?,?)").bind(messageId,channelId,user.id,content).run();
      await audit(env,user,"channel_message_sent",channelId,"success",{message_id:messageId});
      return json({ ok: true, id: messageId }, 201);
    }
  }
  if (path === "/api/dms" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT c.id,other.username,other.id AS other_id,MAX(dm.created_at) AS updated_at,(SELECT content FROM direct_messages z WHERE z.conversation_id=c.id AND z.deleted_at IS NULL ORDER BY z.created_at DESC LIMIT 1) AS last_message FROM conversations c JOIN conversation_members mine ON mine.conversation_id=c.id AND mine.user_id=? JOIN conversation_members theirs ON theirs.conversation_id=c.id AND theirs.user_id<>? JOIN users other ON other.id=theirs.user_id LEFT JOIN direct_messages dm ON dm.conversation_id=c.id AND dm.deleted_at IS NULL GROUP BY c.id,other.username,other.id ORDER BY updated_at DESC LIMIT 100").bind(user.id,user.id).all();
    return json({ conversations: rows.results || [] });
  }
  if (path === "/api/dms" && request.method === "POST") {
    const data = await body(request); const username = typeof data?.username === "string" ? data.username.trim() : "";
    if (!username || username.length > 64) return fail("Enter a valid username.");
    const other = await env.DB.prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE AND status='active'").bind(username).first();
    if (!other) return fail("User not found.",404);
    if (other.id === user.id) return fail("You cannot start a conversation with yourself.");
    const found = await env.DB.prepare("SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=? JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=? WHERE (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id=c.id)=2 LIMIT 1").bind(user.id,other.id).first();
    let conversationId = found?.id;
    if (!conversationId) {
      conversationId=id();
      await env.DB.prepare("INSERT INTO conversations(id) VALUES(?)").bind(conversationId).run();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?)").bind(conversationId,user.id),
        env.DB.prepare("INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?)").bind(conversationId,other.id)
      ]);
      await audit(env,user,"direct_conversation_created",other.username);
    }
    return json({ conversation: { id: conversationId, username: other.username } },201);
  }
  const dmMessages = path.match(/^\/api\/dms\/([^/]+)\/messages$/);
  if (dmMessages) {
    const conversationId=decodeURIComponent(dmMessages[1]);
    const membership=await env.DB.prepare("SELECT 1 AS ok FROM conversation_members WHERE conversation_id=? AND user_id=?").bind(conversationId,user.id).first();
    if(!membership) return fail("Conversation not found or access denied.",404);
    if(request.method==="GET"){
      const rows=await env.DB.prepare("SELECT dm.id,dm.content,dm.created_at,u.username FROM direct_messages dm JOIN users u ON u.id=dm.sender_id WHERE dm.conversation_id=? AND dm.deleted_at IS NULL ORDER BY dm.created_at DESC LIMIT 100").bind(conversationId).all();
      return json({messages:(rows.results||[]).reverse()});
    }
    if(request.method==="POST"){
      const data=await body(request);const content=typeof data?.content==="string"?data.content.trim():"";
      if(!content||content.length>4000)return fail("Messages must be between 1 and 4000 characters.");
      const messageId=id();
      await env.DB.prepare("INSERT INTO direct_messages(id,conversation_id,sender_id,content) VALUES(?,?,?,?)").bind(messageId,conversationId,user.id,content).run();
      await env.DB.prepare("UPDATE conversations SET updated_at=? WHERE id=?").bind(new Date().toISOString(),conversationId).run();
      await audit(env,user,"direct_message_sent",conversationId,"success",{message_id:messageId});
      return json({ok:true,id:messageId},201);
    }
  }
  if (path === "/api/admin/users" && request.method === "POST") {
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const data=await body(request);const username=typeof data?.username==="string"?data.username.trim():"";const password=typeof data?.password==="string"?data.password:"";const role=data?.role||"student";
    if(!/^[a-zA-Z0-9._-]{3,64}$/.test(username))return fail("Username must be 3-64 characters using letters, numbers, dots, underscores, or hyphens.");
    if(password.length<14||password.length>256)return fail("Set a unique initial password of at least 14 characters.");
    if(!ROLES.includes(role))return fail("Invalid role.");
    const exists=await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();if(exists)return fail("That username is already taken.",409);
    const userId=id();const hash=await passwordHash(password);
    await env.DB.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)").bind(userId,username,hash,role).run();
    await audit(env,user,"user_created",username,"success",{role});
    return json({ok:true,id:userId,username,role},201);
  }
  if (path === "/api/admin/users" && request.method === "GET") {
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const rows=await env.DB.prepare("SELECT id,username,role,status,created_at,last_login_at FROM users ORDER BY created_at DESC LIMIT 500").all();
    return json({users:rows.results||[]});
  }
  const roleRoute=path.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if(roleRoute&&request.method==="PATCH"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const targetId=decodeURIComponent(roleRoute[1]);const data=await body(request);
    if(!ROLES.includes(data?.role))return fail("Invalid role.");
    if(targetId===user.id&&data.role!=="administrator")return fail("You cannot remove your own administrator role.",403);
    const target=await env.DB.prepare("SELECT id,username,role FROM users WHERE id=?").bind(targetId).first();
    if(!target)return fail("User not found.",404);
    await env.DB.prepare("UPDATE users SET role=?,updated_at=? WHERE id=?").bind(data.role,new Date().toISOString(),targetId).run();
    await audit(env,user,"user_role_changed",target.username,"success",{from:target.role,to:data.role});
    return json({ok:true});
  }
  if(path==="/api/admin/audit"&&request.method==="GET"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    await audit(env,user,"audit_log_viewed","audit_logs");
    const limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit"))||100));
    const rows=await env.DB.prepare("SELECT id,actor_username,action,target,result,details_json,created_at FROM audit_logs ORDER BY id DESC LIMIT ?").bind(limit).all();
    return json({events:rows.results||[]});
  }
  if(path==="/api/admin/classes"&&request.method==="POST"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const data=await body(request);const name=typeof data?.name==="string"?data.name.trim():"";const description=typeof data?.description==="string"?data.description.trim().slice(0,500):"";
    if(!name||name.length>100)return fail("Class name must be between 1 and 100 characters.");
    const classId=id();await env.DB.prepare("INSERT INTO classes(id,name,description,created_by) VALUES(?,?,?,?)").bind(classId,name,description,user.id).run();
    await env.DB.prepare("INSERT INTO class_members(class_id,user_id,class_role) VALUES(?,?,'teacher')").bind(classId,user.id).run();
    await audit(env,user,"class_created",name);
    return json({ok:true,id:classId},201);
  }
  if(path==="/api/admin/channels"&&request.method==="POST"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const data=await body(request);const classId=String(data?.class_id||"");const name=typeof data?.name==="string"?data.name.trim().toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-"):"";const description=typeof data?.description==="string"?data.description.trim().slice(0,500):"";
    if(!classId||!name||name.length>80)return fail("Class and valid channel name are required.");
    const cls=await env.DB.prepare("SELECT id FROM classes WHERE id=?").bind(classId).first();if(!cls)return fail("Class not found.",404);
    const channelId=id();await env.DB.prepare("INSERT INTO channels(id,class_id,name,description,created_by) VALUES(?,?,?,?,?)").bind(channelId,classId,name,description,user.id).run();
    await audit(env,user,"channel_created",name,"success",{class_id:classId});
    return json({ok:true,id:channelId},201);
  }
  if(path==="/api/admin/classes"&&request.method==="GET"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const rows=await env.DB.prepare("SELECT id,name,description,created_at FROM classes ORDER BY name").all();return json({classes:rows.results||[]});
  }
  if(path==="/api/reports"&&request.method==="POST"){
    const data=await body(request);const targetType=data?.target_type;const targetId=String(data?.target_id||"");const reason=typeof data?.reason==="string"?data.reason.trim().slice(0,1000):"";
    if(!["user","channel_message","direct_message"].includes(targetType)||!targetId||!reason)return fail("Target and reason are required.");
    const reportId=id();await env.DB.prepare("INSERT INTO reports(id,reporter_id,target_type,target_id,reason) VALUES(?,?,?,?,?)").bind(reportId,user.id,targetType,targetId,reason).run();
    await audit(env,user,"report_submitted",targetType+":"+targetId);
    return json({ok:true,id:reportId},201);
  }
  if(path==="/api/admin/reports"&&request.method==="GET"){
    if(!requireRole(user,STAFF_ROLES))return fail("Moderator permission required.",403);
    const rows=await env.DB.prepare("SELECT r.id,r.target_type,r.target_id,r.reason,r.status,r.created_at,u.username AS reporter FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 200").all();return json({reports:rows.results||[]});
  }
  return fail("Not found.",404);
}
export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "GET" && new URL(request.url).pathname === "/") {
        if (env.ASSETS) return env.ASSETS.fetch(request);
      }
      if (request.method === "GET" && !new URL(request.url).pathname.startsWith("/api/") && env.ASSETS) return env.ASSETS.fetch(request);
      return await handle(request, env);
    } catch (error) {
      console.error("Campusly request failed", error?.message || error);
      return fail("A server error occurred. Check the deployment logs for a request identifier.", 500);
    }
  },
  async scheduled(controller, env, ctx) {
    try {
      await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()).run();
      await seedAdmin(env);
    } catch (e) { console.error("Scheduled maintenance failed", e?.message); }
  }
};

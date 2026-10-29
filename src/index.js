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
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, material, 256);
  return "pbkdf2-sha256$100000$" + salt + "$" + toHex(bits);
}
async function verifyPassword(password, stored) {
  const [scheme, rounds, salt, expected] = String(stored).split("$");
  if (scheme !== "pbkdf2-sha256" || Number(rounds) !== 100000 || !salt || !expected) return false;
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, material, 256);
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
  const row = await env.DB.prepare("SELECT u.id,u.username,u.display_name,u.avatar_url,u.role,u.status,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? LIMIT 1").bind(idHash, new Date().toISOString()).first();
  return row && row.status === "active" ? row : null;
}
function requireRole(user, roles) { return !!user && roles.has(user.role); }
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  return user || null;
}
function id() { return uuid(); }

const DEFAULT_CLASS_SERVERS = [
  { name: "AP Human Geography", description: "Human geography, migration, culture, population, and spatial patterns.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["homework-help","Homework questions and study help"],["map-skills","Maps, regions, and spatial analysis"],["resources","Study guides and class resources"],["projects","Group projects"]] },
  { name: "English Language Arts", description: "Reading, writing, literature, and communication.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["homework-help","Writing and reading assignment help"],["reading-discussion","Discuss class readings"],["writing-workshop","Drafts, feedback, and writing tips"],["resources","Class resources"]] },
  { name: "Algebra 1", description: "Equations, functions, graphing, and algebra practice.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["homework-help","Help with assignments"],["show-your-work","Explain problem-solving steps"],["test-review","Review for quizzes and tests"],["resources","Formula sheets and practice resources"]] },
  { name: "Earth Science", description: "Earth systems, weather, geology, space, and scientific investigation.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["homework-help","Assignment questions"],["lab-discussion","Discuss lab concepts and observations"],["study-guides","Review guides and vocabulary"],["resources","Class resources"]] },
  { name: "AVID", description: "Organization, academic skills, collaboration, and college/career readiness.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["tutorials","Tutorial and inquiry questions"],["organization","Planners, binders, and study habits"],["college-career","College and career exploration"],["community-service","Community involvement and service"]] },
  { name: "Health", description: "Health education, wellness, and class assignments.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["homework-help","Assignment questions"],["study-guides","Review guides and vocabulary"],["resources","Class resources"]] },
  { name: "Chamber Choir", description: "Choir announcements, rehearsal preparation, and music activities.", channels: [["general","Choir community"],["announcements","Rehearsal and performance updates"],["rehearsal-prep","Practice notes and preparation"],["performances","Concerts and event coordination"],["resources","Approved class materials and resources"]] },
  { name: "Computer Science", description: "Programming, computational thinking, and technology projects.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["coding-help","Programming questions and debugging"],["projects","Project collaboration"],["showcase","Share completed class projects"],["resources","Class resources and references"]] },
  { name: "World Languages", description: "Language practice, vocabulary, and cultural learning.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["homework-help","Assignment questions"],["vocabulary-practice","Vocabulary and practice"],["culture","Cultural topics and class activities"],["resources","Class resources"]] },
  { name: "Physical Education", description: "PE class announcements, assignments, and activity information.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["assignments","Class assignments"],["resources","Class resources"]] },
  { name: "Fine Arts & Electives", description: "Creative projects, electives, and cross-class collaboration.", channels: [["general","Class discussion"],["announcements","Class updates and reminders"],["projects","Project collaboration"],["showcase","Share work and ideas"],["resources","Class resources"]] }
];
async function ensureDefaultClassServers(env, actor) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS class_template_exclusions (name TEXT PRIMARY KEY, deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT)").run();
  for (const template of DEFAULT_CLASS_SERVERS) {
    const excluded = await env.DB.prepare("SELECT name FROM class_template_exclusions WHERE name=? COLLATE NOCASE").bind(template.name).first();
    if (excluded) continue;
    let cls = await env.DB.prepare("SELECT id FROM classes WHERE name=? COLLATE NOCASE LIMIT 1").bind(template.name).first();
    if (!cls) {
      const classId = id();
      const inviteCode = toHex(crypto.getRandomValues(new Uint8Array(5)));
      await env.DB.prepare("INSERT INTO classes(id,name,description,created_by,invite_code) VALUES(?,?,?,NULL,?)").bind(classId, template.name, template.description, inviteCode).run();
      cls = { id: classId };
    }
    for (const [name, description] of template.channels) {
      const existing = await env.DB.prepare("SELECT id FROM channels WHERE class_id=? AND name=? COLLATE NOCASE LIMIT 1").bind(cls.id, name).first();
      if (!existing) {
        await env.DB.prepare("INSERT INTO channels(id,class_id,name,description,visibility,created_by) VALUES(?,?,?,?, 'class', NULL)").bind(id(), cls.id, name, description).run();
      }
    }
  }
}

async function seedAdmin(env) {
  if (!env.ADMIN_USERNAME || !env.CAMPUSLY_BOOTSTRAP_ADMIN_PASSWORD) return;
  const username = String(env.ADMIN_USERNAME).trim();
  const password = String(env.CAMPUSLY_BOOTSTRAP_ADMIN_PASSWORD);
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username) || password.length < 6) {
    console.error("Admin bootstrap skipped: username format or minimum password length policy failed.");
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
    const user = await env.DB.prepare("SELECT id,username,display_name,avatar_url,password_hash,role,status FROM users WHERE username=? COLLATE NOCASE LIMIT 1").bind(data.username.trim()).first();
    if (!user || user.status !== "active" || !(await verifyPassword(data.password, user.password_hash))) {
      await audit(env, user ? { id: user.id, username: user.username } : null, "login_failed", data.username.trim().slice(0,64), "denied", { reason: "invalid_credentials" });
      return fail("Invalid username or password.", 401);
    }
    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await env.DB.prepare("INSERT INTO sessions(id_hash,user_id,expires_at,user_agent) VALUES(?,?,?,?)").bind(await digest(token), user.id, expires, (request.headers.get("User-Agent") || "").slice(0,240)).run();
    await env.DB.prepare("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?").bind(new Date().toISOString(), new Date().toISOString(), user.id).run();
    await audit(env, user, "login_success", user.username);
    return json({ user: { id: user.id, username: user.username, display_name: user.display_name || user.username, avatar_url: user.avatar_url || "", role: user.role } }, 200, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
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

  if (path === "/api/profile" && request.method === "PATCH") {
    const data = await body(request);
    const username = typeof data?.username === "string" ? data.username.trim() : "";
    const displayName = typeof data?.display_name === "string" ? data.display_name.trim() : "";
    const avatarUrl = typeof data?.avatar_url === "string" ? data.avatar_url.trim() : "";
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) return fail("Username must be 3-64 characters using letters, numbers, dots, underscores, or hyphens.");
    if (!displayName || displayName.length > 80) return fail("Display name must be between 1 and 80 characters.");
    if (avatarUrl.length > 280000 || (avatarUrl && !/^https:\/\//i.test(avatarUrl) && !/^data:image\/(png|jpeg|webp);base64,/i.test(avatarUrl))) return fail("Use an HTTPS image URL or upload a PNG, JPEG, or WebP image under 180 KB.");
    const existing = await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?").bind(username, user.id).first();
    if (existing) return fail("That username is already taken.", 409);
    await env.DB.prepare("UPDATE users SET username=?,display_name=?,avatar_url=?,updated_at=? WHERE id=?").bind(username, displayName, avatarUrl, new Date().toISOString(), user.id).run();
    await audit(env, user, "profile_updated", user.username, "success", { username_changed: username !== user.username, display_name_changed: displayName !== (user.display_name || user.username), avatar_changed: avatarUrl !== (user.avatar_url || "") });
    return json({ ok: true, user: { id: user.id, username, display_name: displayName, avatar_url: avatarUrl, role: user.role } });
  }

  if (path === "/api/announcements" && request.method === "GET") {
    const audienceRoles = user.role === "student" ? ["all","students"] : user.role === "teacher" ? ["all","teachers","staff"] : ["all","staff"];
    const placeholders = audienceRoles.map(() => "?").join(",");
    const rows = await env.DB.prepare("SELECT id,title,body,audience,pinned,created_at,updated_at FROM announcements WHERE active=1 AND audience IN ("+placeholders+") ORDER BY pinned DESC,created_at DESC LIMIT 30").bind(...audienceRoles).all();
    return json({announcements:rows.results||[]});
  }
  if (path === "/api/class-catalog" && request.method === "GET") {
    await ensureDefaultClassServers(env, user);
    const rows = await env.DB.prepare("SELECT c.id,c.name,c.description,(SELECT COUNT(*) FROM class_members cm2 WHERE cm2.class_id=c.id) AS member_count,EXISTS(SELECT 1 FROM class_members cm WHERE cm.class_id=c.id AND cm.user_id=?) AS joined,(SELECT GROUP_CONCAT(ch.name, ', ') FROM channels ch WHERE ch.class_id=c.id) AS channel_names FROM classes c ORDER BY CASE c.name WHEN 'AP Human Geography' THEN 1 WHEN 'English Language Arts' THEN 2 WHEN 'Algebra 1' THEN 3 WHEN 'Earth Science' THEN 4 WHEN 'AVID' THEN 5 WHEN 'Health' THEN 6 WHEN 'Chamber Choir' THEN 7 WHEN 'Computer Science' THEN 8 WHEN 'World Languages' THEN 9 WHEN 'Physical Education' THEN 10 WHEN 'Fine Arts & Electives' THEN 11 ELSE 99 END,c.name LIMIT 200").bind(user.id).all();
    return json({ classes: (rows.results || []).map(row => ({ ...row, joined: Boolean(row.joined) })) });
  }
  if (path === "/api/class-catalog/join" && request.method === "POST") {
    const data = await body(request);
    const classId = typeof data?.class_id === "string" ? data.class_id : "";
    if (!classId) return fail("Choose a class server to join.");
    const cls = await env.DB.prepare("SELECT id,name FROM classes WHERE id=?").bind(classId).first();
    if (!cls) return fail("Class server not found.", 404);
    const prior = await env.DB.prepare("SELECT 1 AS ok FROM class_members WHERE class_id=? AND user_id=?").bind(classId,user.id).first();
    await env.DB.prepare("INSERT INTO class_members(class_id,user_id,class_role) VALUES(?,?,'student') ON CONFLICT(class_id,user_id) DO NOTHING").bind(classId,user.id).run();
    if (!prior) await audit(env,user,"default_class_joined",cls.name,"success",{class_id:classId});
    return json({ok:true,server:{id:cls.id,name:cls.name}});
  }

  if (path === "/api/servers" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT c.id,c.name,c.description,c.invite_code,cm.class_role AS server_role,(SELECT COUNT(*) FROM class_members members WHERE members.class_id=c.id) AS member_count FROM classes c JOIN class_members cm ON cm.class_id=c.id AND cm.user_id=? ORDER BY c.name LIMIT 200").bind(user.id).all();
    return json({ servers: rows.results || [] });
  }
  if (path === "/api/servers" && request.method === "POST") {
    const data = await body(request);
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    const description = typeof data?.description === "string" ? data.description.trim().slice(0, 500) : "";
    if (!name || name.length > 80) return fail("Server name must be between 1 and 80 characters.");
    const serverId = id();
    const inviteCode = toHex(crypto.getRandomValues(new Uint8Array(5)));
    await env.DB.prepare("INSERT INTO classes(id,name,description,created_by,invite_code) VALUES(?,?,?,?,?)").bind(serverId, name, description, user.id, inviteCode).run();
    await env.DB.prepare("INSERT INTO class_members(class_id,user_id,class_role) VALUES(?,?,'teacher')").bind(serverId, user.id).run();
    const channelId = id();
    await env.DB.prepare("INSERT INTO channels(id,class_id,name,description,visibility,created_by) VALUES(?,?, 'general','General server chat','class',?)").bind(channelId, serverId, user.id).run();
    await audit(env, user, "server_created", name, "success", { server_id: serverId });
    return json({ ok: true, server: { id: serverId, name, description, invite_code: inviteCode, server_role: "teacher", member_count: 1 } }, 201);
  }
  if (path === "/api/servers/join" && request.method === "POST") {
    const data = await body(request);
    const code = typeof data?.invite_code === "string" ? data.invite_code.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{8,10}$/.test(code)) return fail("Enter a valid server invite code.");
    const server = await env.DB.prepare("SELECT id,name FROM classes WHERE invite_code=?").bind(code).first();
    if (!server) return fail("That server invite code was not found.", 404);
    const prior = await env.DB.prepare("SELECT 1 AS ok FROM class_members WHERE class_id=? AND user_id=?").bind(server.id, user.id).first();
    await env.DB.prepare("INSERT INTO class_members(class_id,user_id,class_role) VALUES(?,?,'student') ON CONFLICT(class_id,user_id) DO NOTHING").bind(server.id, user.id).run();
    if (!prior) await audit(env, user, "server_joined", server.name, "success", { server_id: server.id });
    return json({ ok: true, server: { id: server.id, name: server.name } });
  }
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
      const rows = await env.DB.prepare("SELECT m.id,m.content,m.created_at,u.username,u.display_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.channel_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 100").bind(channelId).all();
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
      const rows=await env.DB.prepare("SELECT dm.id,dm.content,dm.created_at,u.username,u.display_name,u.avatar_url FROM direct_messages dm JOIN users u ON u.id=dm.sender_id WHERE dm.conversation_id=? AND dm.deleted_at IS NULL ORDER BY dm.created_at DESC LIMIT 100").bind(conversationId).all();
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
    if(password.length<6||password.length>256)return fail("Set a unique initial password of at least 6 characters.");
    if(!ROLES.includes(role))return fail("Invalid role.");
    const exists=await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();if(exists)return fail("That username is already taken.",409);
    const userId=id();const hash=await passwordHash(password);
    await env.DB.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)").bind(userId,username,hash,role).run();
    await audit(env,user,"user_created",username,"success",{role});
    return json({ok:true,id:userId,username,role},201);
  }
  if (path === "/api/admin/users" && request.method === "GET") {
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const rows=await env.DB.prepare("SELECT id,username,display_name,role,status,created_at,last_login_at FROM users ORDER BY created_at DESC LIMIT 500").all();
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
    const data=await body(request);const classId=String(data?.class_id||"");const name=typeof data?.name==="string"?data.name.trim().toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-"):"";const description=typeof data?.description==="string"?data.description.trim().slice(0,500):"";
    if(!classId||!name||name.length>80)return fail("Server and valid channel name are required.");
    if(!requireRole(user,ADMIN_ROLES)){const canManage=await env.DB.prepare("SELECT 1 AS ok FROM class_members WHERE class_id=? AND user_id=? AND class_role='teacher'").bind(classId,user.id).first();if(!canManage)return fail("Only this server's owner or an administrator can create channels.",403);}
    const cls=await env.DB.prepare("SELECT id FROM classes WHERE id=?").bind(classId).first();if(!cls)return fail("Server not found.",404);
    const channelId=id();await env.DB.prepare("INSERT INTO channels(id,class_id,name,description,created_by) VALUES(?,?,?,?,?)").bind(channelId,classId,name,description,user.id).run();
    await audit(env,user,"channel_created",name,"success",{class_id:classId});
    return json({ok:true,id:channelId},201);
  }
  if(path==="/api/admin/classes"&&request.method==="GET"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const rows=await env.DB.prepare("SELECT id,name,description,created_at FROM classes ORDER BY name").all();const classes=[];for(const cls of rows.results||[]){const channels=await env.DB.prepare("SELECT id,name,description FROM channels WHERE class_id=? ORDER BY name").bind(cls.id).all();classes.push({...cls,channels:channels.results||[]});}return json({classes});
  }
  const adminClassRoute=path.match(/^\/api\/admin\/classes\/([^/]+)$/);
  if(adminClassRoute&&request.method==="PATCH"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const classId=decodeURIComponent(adminClassRoute[1]);const data=await body(request);
    const name=typeof data?.name==="string"?data.name.trim():"";const description=typeof data?.description==="string"?data.description.trim().slice(0,500):"";
    if(!name||name.length>100)return fail("Server name must be between 1 and 100 characters.");
    const cls=await env.DB.prepare("SELECT id,name FROM classes WHERE id=?").bind(classId).first();if(!cls)return fail("Server not found.",404);
    const collision=await env.DB.prepare("SELECT id FROM classes WHERE name=? COLLATE NOCASE AND id<>?").bind(name,classId).first();if(collision)return fail("A server with that name already exists.");
    await env.DB.prepare("UPDATE classes SET name=?,description=? WHERE id=?").bind(name,description,classId).run();
    const template=DEFAULT_CLASS_SERVERS.find(t=>t.name.toLowerCase()===cls.name.toLowerCase());
    if(template&&template.name.toLowerCase()!==name.toLowerCase()){
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS class_template_exclusions (name TEXT PRIMARY KEY, deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT)").run();
      await env.DB.prepare("INSERT INTO class_template_exclusions(name,deleted_by) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET deleted_at=CURRENT_TIMESTAMP,deleted_by=excluded.deleted_by").bind(template.name,user.id).run();
    }
    await audit(env,user,"class_renamed",cls.name,"success",{class_id:classId,new_name:name});
    return json({ok:true,name});
  }
  if(adminClassRoute&&request.method==="DELETE"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const classId=decodeURIComponent(adminClassRoute[1]);const cls=await env.DB.prepare("SELECT id,name FROM classes WHERE id=?").bind(classId).first();if(!cls)return fail("Server not found.",404);
    const template=DEFAULT_CLASS_SERVERS.find(t=>t.name.toLowerCase()===cls.name.toLowerCase());
    if(template){
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS class_template_exclusions (name TEXT PRIMARY KEY, deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT)").run();
      await env.DB.prepare("INSERT INTO class_template_exclusions(name,deleted_by) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET deleted_at=CURRENT_TIMESTAMP,deleted_by=excluded.deleted_by").bind(template.name,user.id).run();
    }
    await env.DB.prepare("DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE class_id=?)").bind(classId).run();
    await env.DB.prepare("DELETE FROM channels WHERE class_id=?").bind(classId).run();
    await env.DB.prepare("DELETE FROM classes WHERE id=?").bind(classId).run();
    await audit(env,user,"class_deleted",cls.name,"success",{class_id:classId});
    return json({ok:true});
  }
  const adminChannelRoute=path.match(/^\/api\/admin\/channels\/([^/]+)$/);
  if(adminChannelRoute&&request.method==="DELETE"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const channelId=decodeURIComponent(adminChannelRoute[1]);
    const channel=await env.DB.prepare("SELECT ch.id,ch.name,c.name AS class_name FROM channels ch JOIN classes c ON c.id=ch.class_id WHERE ch.id=?").bind(channelId).first();
    if(!channel)return fail("Channel not found.",404);
    await env.DB.prepare("DELETE FROM messages WHERE channel_id=?").bind(channelId).run();
    await env.DB.prepare("DELETE FROM channels WHERE id=?").bind(channelId).run();
    await audit(env,user,"channel_deleted",channel.name,"success",{channel_id:channelId,class_name:channel.class_name});
    return json({ok:true});
  }
  const adminClearChatRoute=path.match(/^\/api\/admin\/channels\/([^/]+)\/messages$/);
  if(adminClearChatRoute&&request.method==="DELETE"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const channelId=decodeURIComponent(adminClearChatRoute[1]);
    const channel=await env.DB.prepare("SELECT ch.id,ch.name,c.name AS class_name FROM channels ch JOIN classes c ON c.id=ch.class_id WHERE ch.id=?").bind(channelId).first();
    if(!channel)return fail("Channel not found.",404);
    const result=await env.DB.prepare("DELETE FROM messages WHERE channel_id=?").bind(channelId).run();
    await audit(env,user,"channel_chat_cleared",channel.name,"success",{channel_id:channelId,class_name:channel.class_name,deleted_count:result.meta?.changes||0});
    return json({ok:true,deleted_count:result.meta?.changes||0});
  }
  const adminDeleteMessageRoute=path.match(/^\/api\/admin\/channels\/([^/]+)\/messages\/([^/]+)$/);
  if(adminDeleteMessageRoute&&request.method==="DELETE"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const channelId=decodeURIComponent(adminDeleteMessageRoute[1]);const messageId=decodeURIComponent(adminDeleteMessageRoute[2]);
    const msg=await env.DB.prepare("SELECT id FROM messages WHERE id=? AND channel_id=? AND deleted_at IS NULL").bind(messageId,channelId).first();
    if(!msg)return fail("Message not found.",404);
    await env.DB.prepare("UPDATE messages SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND channel_id=?").bind(messageId,channelId).run();
    await audit(env,user,"channel_message_deleted",messageId,"success",{channel_id:channelId});
    return json({ok:true});
  }
  const classMemberParts=path.split("/");
  const classMemberRoute=classMemberParts.length===6&&classMemberParts[1]==="api"&&classMemberParts[2]==="admin"&&classMemberParts[3]==="classes"&&classMemberParts[5]==="members"?[null,classMemberParts[4]]:null;
  if(classMemberRoute&&request.method==="POST"){
    if(!requireRole(user,ADMIN_ROLES))return fail("Administrator permission required.",403);
    const classId=decodeURIComponent(classMemberRoute[1]);const data=await body(request);const username=typeof data?.username==="string"?data.username.trim():"";const classRole=data?.class_role==="teacher"?"teacher":"student";
    const cls=await env.DB.prepare("SELECT id,name FROM classes WHERE id=?").bind(classId).first();if(!cls)return fail("Class not found.",404);
    const target=await env.DB.prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE AND status='active'").bind(username).first();if(!target)return fail("Active user not found.",404);
    await env.DB.prepare("INSERT INTO class_members(class_id,user_id,class_role) VALUES(?,?,?) ON CONFLICT(class_id,user_id) DO UPDATE SET class_role=excluded.class_role").bind(classId,target.id,classRole).run();
    await audit(env,user,"class_member_added",cls.name,"success",{member:target.username,class_role:classRole});
    return json({ok:true,username:target.username,class_role:classRole},201);
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
    const rows=await env.DB.prepare("SELECT r.id,r.target_type,r.target_id,r.reason,r.status,r.created_at,u.username AS reporter FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,r.created_at DESC LIMIT 200").all();
    return json({reports:rows.results||[]});
  }
  const reportStatusRoute=path.match(/^\/api\/admin\/reports\/([^/]+)$/);
  if(reportStatusRoute&&request.method==="PATCH"){
    if(!requireRole(user,STAFF_ROLES))return fail("Moderator permission required.",403);
    const data=await body(request);
    const status=String(data?.status||"");
    if(!["open","reviewing","resolved","dismissed"].includes(status))return fail("Invalid report status.");
    const reportId=decodeURIComponent(reportStatusRoute[1]);
    const report=await env.DB.prepare("SELECT id,status FROM reports WHERE id=?").bind(reportId).first();
    if(!report)return fail("Report not found.",404);
    const resolvedAt=["resolved","dismissed"].includes(status)?new Date().toISOString():null;
    const assignedTo=["reviewing","resolved","dismissed"].includes(status)?user.id:null;
    await env.DB.prepare("UPDATE reports SET status=?,assigned_to=?,resolved_at=? WHERE id=?").bind(status,assignedTo,resolvedAt,reportId).run();
    await audit(env,user,"report_status_changed",reportId,"success",{from:report.status,to:status});
    return json({ok:true,status});
  }

  // Administrative control-plane tables are created idempotently so the dashboard can be
  // deployed without a separate manual migration step.
  if (path.startsWith("/api/admin/")) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'all', pinned INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  }
  if (path === "/api/admin/overview" && request.method === "GET") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.", 403);
    const count = async (sql) => Number((await env.DB.prepare(sql).first())?.n || 0);
    const [usersCount, activeUsers, classesCount, channelsCount, messagesCount, reportsCount, announcementsCount] = await Promise.all([
      count("SELECT COUNT(*) n FROM users"),
      count("SELECT COUNT(*) n FROM users WHERE status='active'"),
      count("SELECT COUNT(*) n FROM classes"),
      count("SELECT COUNT(*) n FROM channels"),
      count("SELECT COUNT(*) n FROM messages WHERE deleted_at IS NULL"),
      count("SELECT COUNT(*) n FROM reports WHERE status IN ('open','reviewing')"),
      count("SELECT COUNT(*) n FROM announcements")
    ]);
    return json({stats:{users:usersCount,active_users:activeUsers,classes:classesCount,channels:channelsCount,messages:messagesCount,open_reports:reportsCount,announcements:announcementsCount}});
  }
  if (path === "/api/admin/settings" && request.method === "GET") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.", 403);
    const rows = await env.DB.prepare("SELECT setting_key,setting_value,updated_at FROM site_settings ORDER BY setting_key").all();
    const settings = Object.fromEntries((rows.results || []).map(r => [r.setting_key, (() => { try { return JSON.parse(r.setting_value); } catch { return r.setting_value; } })()]));
    return json({settings});
  }
  if (path === "/api/admin/settings" && request.method === "PATCH") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.", 403);
    const data = await body(request);
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail("Provide a settings object.");
    const allowed = new Set(["site_name","school_name","tagline","announcement_banner","allow_student_signup","maintenance_mode","max_message_length","accent_color","support_url"]);
    for (const [key,value] of Object.entries(data)) {
      if (!allowed.has(key)) return fail("Setting is not editable: " + key);
      if (["site_name","school_name","tagline","announcement_banner","accent_color","support_url"].includes(key) && typeof value !== "string") return fail("Invalid value for " + key);
      if (["allow_student_signup","maintenance_mode"].includes(key) && typeof value !== "boolean") return fail("Invalid value for " + key);
      if (key === "max_message_length" && (!Number.isInteger(value) || value < 100 || value > 4000)) return fail("Message length must be between 100 and 4000.");
      const encoded = JSON.stringify(value);
      await env.DB.prepare("INSERT INTO site_settings(setting_key,setting_value,updated_by,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP").bind(key,encoded,user.id).run();
    }
    await audit(env,user,"site_settings_updated","site_settings","success",{keys:Object.keys(data)});
    return json({ok:true});
  }
  if (path === "/api/admin/announcements" && request.method === "GET") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.", 403);
    const rows = await env.DB.prepare("SELECT a.id,a.title,a.body,a.audience,a.pinned,a.active,a.created_at,a.updated_at,u.username AS author FROM announcements a LEFT JOIN users u ON u.id=a.created_by ORDER BY a.pinned DESC,a.created_at DESC LIMIT 200").all();
    return json({announcements:rows.results||[]});
  }
  if (path === "/api/admin/announcements" && request.method === "POST") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.", 403);
    const data = await body(request);
    const title = typeof data?.title === "string" ? data.title.trim().slice(0,160) : "";
    const announcementBody = typeof data?.body === "string" ? data.body.trim().slice(0,5000) : "";
    const audience = ["all","students","teachers","staff"].includes(data?.audience) ? data.audience : "all";
    if (!title || !announcementBody) return fail("Announcement title and message are required.");
    const announcementId = id();
    await env.DB.prepare("INSERT INTO announcements(id,title,body,audience,pinned,active,created_by) VALUES(?,?,?,?,?,?,?)").bind(announcementId,title,announcementBody,audience,data?.pinned?1:0,data?.active===false?0:1,user.id).run();
    await audit(env,user,"announcement_created",title,"success",{audience});
    return json({ok:true,id:announcementId},201);
  }
  const announcementRoute = path.match(/^\/api\/admin\/announcements\/([^/]+)$/);
  if (announcementRoute && request.method === "PATCH") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.", 403);
    const announcementId = decodeURIComponent(announcementRoute[1]);
    const data = await body(request);
    const current = await env.DB.prepare("SELECT * FROM announcements WHERE id=?").bind(announcementId).first();
    if (!current) return fail("Announcement not found.",404);
    const title = typeof data?.title === "string" ? data.title.trim().slice(0,160) : current.title;
    const announcementBody = typeof data?.body === "string" ? data.body.trim().slice(0,5000) : current.body;
    const audience = data?.audience === undefined ? current.audience : data.audience;
    if (!title || !announcementBody || !["all","students","teachers","staff"].includes(audience)) return fail("Invalid announcement details.");
    const pinned = data?.pinned === undefined ? current.pinned : (data.pinned ? 1 : 0);
    const active = data?.active === undefined ? current.active : (data.active ? 1 : 0);
    await env.DB.prepare("UPDATE announcements SET title=?,body=?,audience=?,pinned=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(title,announcementBody,audience,pinned,active,announcementId).run();
    await audit(env,user,"announcement_updated",announcementId,"success",{title,active:!!active});
    return json({ok:true});
  }
  if (announcementRoute && request.method === "DELETE") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.",403);
    const announcementId = decodeURIComponent(announcementRoute[1]);
    const result = await env.DB.prepare("DELETE FROM announcements WHERE id=?").bind(announcementId).run();
    if (!(result.meta?.changes)) return fail("Announcement not found.",404);
    await audit(env,user,"announcement_deleted",announcementId);
    return json({ok:true});
  }
  const adminUserRoute = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserRoute && request.method === "PATCH") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.",403);
    const targetId = decodeURIComponent(adminUserRoute[1]);
    const data = await body(request);
    const target = await env.DB.prepare("SELECT id,username,role,status FROM users WHERE id=?").bind(targetId).first();
    if (!target) return fail("User not found.",404);
    const role = data?.role === undefined ? target.role : data.role;
    const status = data?.status === undefined ? target.status : data.status;
    const displayName = data?.display_name === undefined ? null : String(data.display_name).trim().slice(0,100);
    const password = data?.password === undefined ? null : String(data.password);
    if (!ROLES.includes(role)) return fail("Invalid role.");
    if (!["active","suspended","disabled"].includes(status)) return fail("Invalid account status.");
    if (targetId === user.id && (role !== "administrator" || status !== "active")) return fail("You cannot demote or disable your own administrator account.",403);
    if (target.role === "administrator" && (role !== "administrator" || status !== "active")) {
      const n = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='administrator' AND status='active'").first();
      if (Number(n?.n || 0) <= 1) return fail("Campusly must retain at least one active administrator.",403);
    }
    if (password !== null && (password.length < 6 || password.length > 256)) return fail("Password must be between 6 and 256 characters.");
    const hash = password === null ? null : await passwordHash(password);
    await env.DB.prepare("UPDATE users SET role=?,status=?,display_name=COALESCE(?,display_name),password_hash=COALESCE(?,password_hash),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(role,status,displayName,hash,targetId).run();
    if (status !== "active" || password !== null) await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(targetId).run();
    await audit(env,user,"user_updated",target.username,"success",{role,status,password_reset:password!==null});
    return json({ok:true});
  }
  if (adminUserRoute && request.method === "DELETE") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.",403);
    const targetId = decodeURIComponent(adminUserRoute[1]);
    if (targetId === user.id) return fail("You cannot delete your own account.",403);
    const target = await env.DB.prepare("SELECT id,username,role FROM users WHERE id=?").bind(targetId).first();
    if (!target) return fail("User not found.",404);
    if (target.role === "administrator") {
      const n = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='administrator' AND status='active'").first();
      if (Number(n?.n || 0) <= 1) return fail("You cannot remove the last active administrator.",403);
    }
    // Disable rather than hard-delete to preserve moderation/report/audit references.
    await env.DB.prepare("UPDATE users SET status='disabled',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(targetId).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(targetId).run();
    await audit(env,user,"user_disabled",target.username,"success",{method:"admin_delete"});
    return json({ok:true,disabled:true});
  }
  const adminChannelEdit = path.match(/^\/api\/admin\/channels\/([^/]+)$/);
  if (adminChannelEdit && request.method === "PATCH") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.",403);
    const channelId = decodeURIComponent(adminChannelEdit[1]);
    const data = await body(request);
    const current = await env.DB.prepare("SELECT id,name,description,visibility,class_id FROM channels WHERE id=?").bind(channelId).first();
    if (!current) return fail("Channel not found.",404);
    const name = data?.name === undefined ? current.name : String(data.name).trim().toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,80);
    const description = data?.description === undefined ? current.description : String(data.description).trim().slice(0,500);
    const visibility = data?.visibility === undefined ? current.visibility : data.visibility;
    if (!name || !["class","private"].includes(visibility)) return fail("Channel name or visibility is invalid.");
    const duplicate = await env.DB.prepare("SELECT id FROM channels WHERE class_id=? AND name=? COLLATE NOCASE AND id<>?").bind(current.class_id,name,channelId).first();
    if (duplicate) return fail("That channel name already exists in this class.",409);
    await env.DB.prepare("UPDATE channels SET name=?,description=?,visibility=? WHERE id=?").bind(name,description,visibility,channelId).run();
    await audit(env,user,"channel_updated",channelId,"success",{name,visibility});
    return json({ok:true});
  }
  const classMembersRoute = path.match(/^\/api\/admin\/classes\/([^/]+)\/members\/([^/]+)$/);
  if (classMembersRoute && request.method === "DELETE") {
    if (!requireRole(user, ADMIN_ROLES)) return fail("Administrator permission required.",403);
    const classId = decodeURIComponent(classMembersRoute[1]), targetId = decodeURIComponent(classMembersRoute[2]);
    const result = await env.DB.prepare("DELETE FROM class_members WHERE class_id=? AND user_id=?").bind(classId,targetId).run();
    if (!(result.meta?.changes)) return fail("Class membership not found.",404);
    await env.DB.prepare("DELETE FROM channel_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE class_id=?)").bind(targetId,classId).run();
    await audit(env,user,"class_member_removed",classId,"success",{user_id:targetId});
    return json({ok:true});
  }

  if(path==="/api/search"&&request.method==="GET"){
    const q=String(url.searchParams.get("q")||"").trim().slice(0,100);
    if(q.length<2)return fail("Enter at least 2 characters to search.");
    const pattern="%"+q+"%";
    const channels=await env.DB.prepare("SELECT ch.id,ch.name,ch.description,ch.class_id,c.name AS class_name FROM channels ch JOIN classes c ON c.id=ch.class_id JOIN class_members cm ON cm.class_id=c.id AND cm.user_id=? WHERE (ch.visibility='class' OR EXISTS(SELECT 1 FROM channel_members x WHERE x.channel_id=ch.id AND x.user_id=?)) AND (ch.name LIKE ? OR ch.description LIKE ?) ORDER BY c.name,ch.name LIMIT 30").bind(user.id,user.id,pattern,pattern).all();
    const messages=await env.DB.prepare("SELECT m.id,m.content,m.created_at,u.username,ch.id AS channel_id,ch.name AS channel_name,c.name AS class_name FROM messages m JOIN channels ch ON ch.id=m.channel_id JOIN classes c ON c.id=ch.class_id JOIN class_members cm ON cm.class_id=c.id AND cm.user_id=? JOIN users u ON u.id=m.sender_id WHERE m.deleted_at IS NULL AND (ch.visibility='class' OR EXISTS(SELECT 1 FROM channel_members x WHERE x.channel_id=ch.id AND x.user_id=?)) AND m.content LIKE ? ORDER BY m.created_at DESC LIMIT 50").bind(user.id,user.id,pattern).all();
    const directMessages=await env.DB.prepare("SELECT dm.id,dm.content,dm.created_at,u.username,dm.conversation_id FROM direct_messages dm JOIN conversation_members mine ON mine.conversation_id=dm.conversation_id AND mine.user_id=? JOIN users u ON u.id=dm.sender_id WHERE dm.deleted_at IS NULL AND dm.content LIKE ? ORDER BY dm.created_at DESC LIMIT 30").bind(user.id,pattern).all();
    return json({query:q,channels:channels.results||[],messages:messages.results||[],direct_messages:directMessages.results||[]});
  }
  return fail("Not found.",404);
}
async function fetchAssetWithoutStaleCache(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "GET" && new URL(request.url).pathname === "/") {
        if (env.ASSETS) return await fetchAssetWithoutStaleCache(request, env);
      }
      if (request.method === "GET" && !new URL(request.url).pathname.startsWith("/api/") && env.ASSETS) {
        return await fetchAssetWithoutStaleCache(request, env);
      }
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

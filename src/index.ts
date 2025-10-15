import { WebSocketServer, WebSocket } from "ws";
import { PrismaClient } from "../app/generated/prisma/client.js";

const prisma = new PrismaClient();
const PORT = 3010;

const activeClients = new Map<WebSocket, { userId: number; roomId: string }>();
const roomUserMap = new Map<string, Set<number>>();

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  console.log("🔌 Client connected");

  ws.on("message", async (data: Buffer) => {
    try {
      const raw = data.toString();
      console.log("📥 Raw message received:", raw);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.error("❌ Failed to parse JSON:", err);
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
        return;
      }

      console.log("🧾 Parsed message:", parsed);

      // Handle registration
      if (parsed.type === "register") {
        if (!parsed.roomId || !parsed.userId) {
          console.error("❌ Missing roomId or userId in register payload:", parsed);
          ws.send(JSON.stringify({ type: "error", message: "Missing roomId or userId" }));
          return;
        }

        const roomId = parsed.roomId;
        const numericUserId = Number(parsed.userId);

        console.log("🔍 Registering for room:", roomId," and type of room: ",typeof(roomId), " user:", numericUserId);

        let room;
        try {
          room = await prisma.roomId.findUnique({
            where: { id: roomId },
            include: { users: true },
          });

          console.log("Room fetched fromDB: ", room);
        } catch (err) {
          console.error("❌ Prisma error while fetching room:", err);
          ws.send(JSON.stringify({ type: "error", message: "Database error during room lookup" }));
          return;
        }
        
        if (!room) {
          console.error("❌ Room not found:", roomId);
          ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
          return;
        }

        const isAuthorized = room.users.some((u) => u.id === numericUserId);
        if (!isAuthorized) {
          console.error("❌ Unauthorized user:", numericUserId, "for room:", roomId);
          ws.send(JSON.stringify({ type: "error", message: "Unauthorized user or room" }));
          return;
        }

        activeClients.set(ws, { userId: numericUserId, roomId });

        if (!roomUserMap.has(roomId)) {
          roomUserMap.set(roomId, new Set());
        }
        roomUserMap.get(roomId)!.add(numericUserId);

        try {
          ws.send(JSON.stringify({ type: "register-success", roomId, userId: numericUserId }));
        } catch (err) {
          console.error("❌ Failed to send register-success:", err);
        }

        return;
      }

      // Handle message
      if (parsed.type === "message") {
        const clientMeta = activeClients.get(ws);
        if (!clientMeta) {
          console.error("❌ Message received from unregistered client");
          ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
          return;
        }

        const { roomId, user_id, text } = parsed;
        const numericUserId = Number(user_id);

        if (roomId !== clientMeta.roomId || numericUserId !== clientMeta.userId) {
          console.error("❌ Invalid room/user context:", parsed);
          ws.send(JSON.stringify({ type: "error", message: "Invalid room or user context" }));
          return;
        }

        let room;
        try {
          room = await prisma.roomId.findUnique({ where: { id: roomId } });
        } catch (err) {
          console.error("❌ Prisma error while validating room:", err);
          ws.send(JSON.stringify({ type: "error", message: "Database error during room validation" }));
          return;
        }

        if (!room) {
          console.error("❌ Room not found during message send:", roomId);
          ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
          return;
        }

        let chat;
        try {
          chat = await prisma.chat.create({
            data: {
              message: text,
              createdAt: new Date(),
              userId: numericUserId,
              roomId: roomId,
            },
          });
        } catch (err) {
          console.error("❌ Failed to create chat:", err);
          ws.send(JSON.stringify({ type: "error", message: "Failed to save message" }));
          return;
        }

        try {
          ws.send(JSON.stringify({ type: "message-sent", chat }));
        } catch (err) {
          console.error("❌ Failed to send message-sent to sender:", err);
        }

        const recipients = roomUserMap.get(roomId);
        if (recipients) {
          for (const [client, meta] of activeClients.entries()) {
            if (
              client !== ws &&
              meta.roomId === roomId &&
              recipients.has(meta.userId) &&
              client.readyState === ws.OPEN
            ) {
              try {
                client.send(JSON.stringify({ type: "new-message", chat }));
              } catch (err) {
                console.error("❌ Failed to broadcast to client:", err);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("❌ Unexpected server error:", err);
      try {
        ws.send(JSON.stringify({ type: "error", message: "Unexpected server error" }));
      } catch (sendErr) {
        console.error("❌ Failed to send error message to client:", sendErr);
      }
    }
  });

  ws.on("close", () => {
    const meta = activeClients.get(ws);
    if (meta) {
      const { roomId, userId } = meta;
      const roomSet = roomUserMap.get(roomId);
      if (roomSet) {
        roomSet.delete(userId);
        if (roomSet.size === 0) {
          roomUserMap.delete(roomId);
        }
      }
    }
    activeClients.delete(ws);
    console.log("❎ Client disconnected");
  });
});

console.log(`🚀 WebSocket server running on ws://localhost:${PORT}`);
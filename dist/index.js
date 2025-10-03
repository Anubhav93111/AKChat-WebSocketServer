import { WebSocketServer, WebSocket } from "ws";
import { PrismaClient } from "../app/generated/prisma/client.js";
const prisma = new PrismaClient();
const PORT = 3010;
// Track connected sockets and their registration info
const activeClients = new Map();
// Track roomId → Set of userIds
const roomUserMap = new Map();
const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
    console.log("🔌 Client connected");
    ws.on("message", async (data) => {
        try {
            const parsed = JSON.parse(data.toString());
            // Handle registration
            if (parsed.type === "register") {
                const { roomId, userId } = parsed;
                const room = await prisma.roomId.findUnique({
                    where: { id: roomId },
                    include: { users: true },
                });
                const isAuthorized = room?.users.some((u) => u.id === userId);
                if (!isAuthorized) {
                    ws.send(JSON.stringify({ type: "error", message: "Unauthorized user or room" }));
                    return;
                }
                // Save registration info
                activeClients.set(ws, { userId, roomId });
                // Update room-user map
                if (!roomUserMap.has(roomId)) {
                    roomUserMap.set(roomId, new Set());
                }
                roomUserMap.get(roomId).add(userId);
                ws.send(JSON.stringify({ type: "register-success", roomId, userId }));
                return;
            }
            // Handle message only if registered
            if (parsed.type === "message") {
                const clientMeta = activeClients.get(ws);
                if (!clientMeta) {
                    ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
                    return;
                }
                const { roomId, user_id, text } = parsed;
                // Validate room match
                if (roomId !== clientMeta.roomId || user_id !== clientMeta.userId) {
                    ws.send(JSON.stringify({ type: "error", message: "Invalid room or user context" }));
                    return;
                }
                const room = await prisma.roomId.findUnique({
                    where: { id: roomId }
                });
                if (!room) {
                    ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
                    return;
                }
                // Create chat
                const chat = await prisma.chat.create({
                    data: {
                        message: text,
                        createdAt: new Date(),
                        userId: user_id,
                        roomId: roomId,
                    },
                });
                // Always respond to sender
                ws.send(JSON.stringify({ type: "message-sent", chat }));
                // Broadcast to other users in the room
                const recipients = roomUserMap.get(roomId);
                if (recipients) {
                    for (const [client, meta] of activeClients.entries()) {
                        if (client !== ws &&
                            meta.roomId === roomId &&
                            recipients.has(meta.userId) &&
                            client.readyState === ws.OPEN) {
                            client.send(JSON.stringify({ type: "new-message", chat }));
                        }
                    }
                }
            }
        }
        catch (err) {
            console.error(" Error:", err);
            ws.send(JSON.stringify({ type: "error", message: "Server error" }));
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
        console.log(" Client disconnected");
    });
});
console.log(` WebSocket server running on ws://localhost:${PORT}`);
//# sourceMappingURL=index.js.map
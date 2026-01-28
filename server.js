require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Usuarios y bloques
let usuarios = {}; // { wallet: { balance, socketId } }
let historial = []; // [{ bloque, ganador, tokens, balance }]
let numeroBloque = 0;
let totalTokensMinados = 0;
let recompensaActual = 10000000; // 10 tokens en microtokens (1 token = 1e6 microtokens)
const reduccionPorBloque = 5;    // 0.000005 tokens = 5 microtokens

// Discord bot
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

discordClient.once("ready", async () => {
  console.log(`Bot conectado como ${discordClient.user.tag}`);
  try {
    const canal = await discordClient.channels.fetch(CHANNEL_ID);
    await canal.send("✅ El bot está conectado y listo para anunciar bloques!");
  } catch (err) {
    console.error("Error al enviar mensaje de prueba:", err);
  }
});

discordClient.login(DISCORD_TOKEN);

// Función para enviar cashout al admin
async function enviarCashoutDiscord(wallet, cantidad) {
  try {
    const adminUser = await discordClient.users.fetch(ADMIN_ID);
    await adminUser.send({
      content: `💸 Nueva solicitud de cashout\nWallet: ${wallet}\nCantidad: ${cantidad} tokens`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Marcar como hecho ✅",
              custom_id: `cashout_${wallet}_${cantidad}`
            }
          ]
        }
      ]
    });
  } catch (err) {
    console.error("Error enviando cashout a Discord:", err);
  }
}

// Manejo de botones en Discord
discordClient.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith("cashout_")) {
    try {
      await interaction.message.delete();
      await interaction.reply({
        content: "✅ Cashout marcado como hecho y mensaje eliminado.",
        ephemeral: true
      });
    } catch (err) {
      console.error("Error al borrar mensaje de cashout:", err);
      await interaction.reply({
        content: "⚠️ No se pudo borrar el mensaje.",
        ephemeral: true
      });
    }

    const logChannel = await discordClient.channels.fetch(LOG_CHANNEL_ID);
    await logChannel.send(
      `📜 Cashout completado:\nWallet: ${interaction.customId.split("_")[1]}\nCantidad: ${interaction.customId.split("_")[2]} tokens\nMarcado por: ${interaction.user.tag}\nVer Wallet On Chain: https://solscan.io/account/${interaction.customId.split("_")[1]}`
    );
  }
});

function emitirUsuariosActivos() {
  const activos = Object.keys(usuarios).filter(w => usuarios[w].socketId).length;
  io.emit("usuariosActivos", { activos });
}

// Conexión de usuarios
io.on("connection", (socket) => {
  socket.on("registrarWallet", (wallet) => {
    // Si la wallet existe y tiene un socketId activo distinto, está en uso
    if (usuarios[wallet] && usuarios[wallet].socketId && usuarios[wallet].socketId !== socket.id) {
      socket.emit("walletError", "❌ Esta wallet ya está en uso en otra sesión.");
      return;
    }

    // Si la wallet ya existía pero estaba desconectada, actualizamos el socketId
    if (usuarios[wallet]) {
      usuarios[wallet].socketId = socket.id;
    } else {
      usuarios[wallet] = { balance: 0, socketId: socket.id };
    }

    console.log("Usuario conectado con wallet:", wallet);

    socket.emit("walletConfirmada", wallet);
    socket.emit("balance", { balance: usuarios[wallet].balance });
    socket.emit("historialCompleto", historial);
       emitirUsuariosActivos(); // 👈 actualizar contador

  });

  socket.on("disconnect", () => {
    for (const [wallet, data] of Object.entries(usuarios)) {
      if (data.socketId === socket.id) {
        console.log(`Wallet ${wallet} desconectada`);
        usuarios[wallet].socketId = null; // balance se conserva
      }
    }
        emitirUsuariosActivos(); // 👈 actualizar contador

  });

  socket.on("verBalance", () => {
    const wallet = Object.keys(usuarios).find(w => usuarios[w].socketId === socket.id);
    if (wallet) {
      socket.emit("balance", { balance: usuarios[wallet].balance } / 1e6);
    }
  });

socket.on("cashout", (cantidadTokens) => {
  const wallet = Object.keys(usuarios).find(w => usuarios[w].socketId === socket.id);
  if (!wallet) return;

  // convertir tokens a microtokens
  const cantidadMicro = Math.floor(cantidadTokens * 1e6);

  if (cantidadMicro > 0 && cantidadMicro <= usuarios[wallet].balance) {
    usuarios[wallet].balance -= cantidadMicro;

    // mostrar siempre en tokens
    socket.emit("cashoutConfirm", { cantidad: cantidadTokens });
    enviarCashoutDiscord(wallet, cantidadTokens);
  } else {
    socket.emit("cashoutError", "❌ Saldo insuficiente");
  }

  });
});

// Cada 5 minutos elegir ganador
setInterval(async () => {
  // Solo wallets activas
  const walletsActivas = Object.keys(usuarios).filter(w => usuarios[w].socketId);
  if (walletsActivas.length > 0) {
    numeroBloque++;
    const ganadorWallet = walletsActivas[Math.floor(Math.random() * walletsActivas.length)];
    usuarios[ganadorWallet].balance += recompensaActual;

    totalTokensMinados += recompensaActual;

    const bloqueInfo = {
      bloque: numeroBloque,
      ganador: ganadorWallet,
      tokens: recompensaActual / 1e6, // 👈 aquí va la recompensa actual
      balance: usuarios[ganadorWallet].balance / 1e6,
      totalTokens: totalTokensMinados / 1e6
    };

    historial.push(bloqueInfo);
    io.emit("bloqueGanado", bloqueInfo);

    try {
      const canal = await discordClient.channels.fetch(CHANNEL_ID);
      await canal.send(
        `🔥 Bloque #${bloqueInfo.bloque} minado!\nGanador: ${bloqueInfo.ganador}\nTotal minado: ${bloqueInfo.totalTokens}`
      );
    } catch (err) {
      console.error("Error al enviar mensaje de bloque:", err);
    }

        // 👇 reducir recompensa para el siguiente bloque
    recompensaActual -= reduccionPorBloque;
    if (recompensaActual < 0) recompensaActual = 0; // nunca negativa

  }
}, 5  * 60 * 1000); // cada 5 minutos

server.listen(3000, () => {
  console.log("Servidor corriendo en http://localhost:3000");
});
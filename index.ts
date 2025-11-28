// src/constants.ts
export const CMD_PREFIX = '/';
export const LOG_LEVEL = 'trace';
export const AUTH_DIR = 'baileys_auth_info';
export const LOG_FILE = './wa-logs.txt';

// src/logger.ts
import pino from 'pino';
import { LOG_LEVEL, LOG_FILE } from './constants';

export const logger = pino({
  level: LOG_LEVEL,
  transport: {
    targets: [
      { target: 'pino-pretty', options: { colorize: true }, level: LOG_LEVEL },
      { target: 'pino/file', options: { destination: LOG_FILE }, level: LOG_LEVEL },
    ],
  },
});

// src/utils.ts
import type { WASocket, WAMessageKey, AnyMessageContent } from '@whiskeysockets/baileys';
import { delay } from '@whiskeysockets/baileys';
import { logger } from './logger';

export async function sendMessageWTyping(
  sock: WASocket,
  jid: string,
  msg: AnyMessageContent
) {
  try {
    await sock.presenceSubscribe(jid);
    await delay(500);
    await sock.sendPresenceUpdate('composing', jid);
    await delay(2000);
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, msg);
  } catch (e) {
    logger.error({ err: e }, 'Erro ao enviar mensagem com digitação');
  }
}

// src/commands.ts
import type { WASocket, WAMessageKey } from '@whiskeysockets/baileys';
import { CMD_PREFIX } from './constants';
import { sendMessageWTyping } from './utils';

export type CommandHandler = (
  sock: WASocket,
  key: WAMessageKey,
  args: string[]
) => Promise<void>;

export const COMMANDS: Record<string, CommandHandler> = {
  // ... (mesmo conteúdo do exemplo anterior) ...
};

export function parseCommand(text: string) {
  if (!text.startsWith(CMD_PREFIX)) return null;
  const parts = text.slice(CMD_PREFIX.length).trim().split(/\s+/);
  const cmd = parts.shift()?.toLowerCase() ?? '';
  return { cmd, args: parts };
}

// src/socket.ts
import makeWASocket, {
  AnyMessageContent,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason,
  Boom,
  delay,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import readline from 'readline';
import { logger } from './logger';
import { AUTH_DIR } from './constants';
import { COMMANDS, parseCommand } from './commands';
import { sendMessageWTyping } from './utils';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (txt: string) => new Promise<string>(res => rl.question(txt, res));

let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

export async function startSock() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Usando WA v${version.join('.')} (latest: ${isLatest})`);

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: state.keys,
      },
      // opcional: passar cache de retry aqui
    });

    // Exemplo de pairing code (mantido)
    if (process.argv.includes('--use-pairing-code') && !sock.authState.creds.registered) {
      const phone = await question('Digite seu número (incluindo DDD e código do país):\n');
      const code = await sock.requestPairingCode(phone);
      console.log(`Código de pareamento: ${code}`);
    }

    // ------------------- EVENT HANDLING -------------------
    sock.ev.process(async events => {
      // Conexão
      if (events['connection.update']) {
        const { connection, lastDisconnect, qr } = events['connection.update'];
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
          const shouldLogout =
            (lastDisconnect?.error as Boom)?.output?.statusCode ===
            DisconnectReason.loggedOut;
          if (!shouldLogout) {
            logger.warn('Conexão fechada, tentando reconectar...');
            setTimeout(startSock, Math.pow(2, ++reconnectAttempts) * 1000);
          } else {
            logger.fatal('Logout detectado. Encerrando.');
          }
        }
        logger.info('Atualização de conexão', events['connection.update']);
      }

      // Credenciais
      if (events['creds.update']) await saveCreds();

      // Mensagens
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert'];
        if (upsert.type !== 'notify') return;

        const promises = upsert.messages.map(async msg => {
          const text =
            msg.message?.conversation ??
            msg.message?.extendedTextMessage?.text;
          if (!text) return;

          const parsed = parseCommand(text);
          if (!parsed) return; // não é comando

          const handler = COMMANDS[parsed.cmd];
          if (handler) {
            await handler(sock, msg.key, parsed.args);
          } else {
            await sendMessageWTyping(sock, msg.key.remoteJid!, {
              text: `⚠️ Comando desconhecido. Use ${CMD_PREFIX}close_group ou ${CMD_PREFIX}open_group.`,
            });
          }
        });

        await Promise.allSettled(promises);
      }

      // Outros eventos (ex.: mensagens atualizadas, presença) podem ser adicionados aqui…
    });

    reconnectAttempts = 0; // reset após conexão bem‑sucedida
    return sock;
  } catch (e) {
    logger.error({ err: e }, 'Erro ao iniciar socket');
    if (reconnectAttempts < MAX_RECONNECT) {
      const delayMs = Math.pow(2, ++reconnectAttempts) * 1000;
      logger.warn(`Nova tentativa em ${delayMs / 1000}s`);
      setTimeout(startSock, delayMs);
    } else {
      logger.fatal('Máximo de tentativas de reconexão alcançado');
    }
  }
}

// src/index.ts
import { startSock } from './socket';

startSock().catch(err => console.error('Falha fatal:', err));

import { Boom } from '@hapi/boom';
import NodeCache from '@cacheable/node-cache';
import readline from 'readline';
import makeWASocket, {
  AnyMessageContent,
  CacheStore,
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getAggregateVotesInPollMessage,
  isJidNewsletter,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WAMessageContent,
  WAMessageKey,
} from '@whiskeysockets/baileys';
import open from 'open';
import fs from 'fs';
import P from 'pino';

/********************************************************************
 *  QR‑CODE TERMINAL
 ********************************************************************/
const qrcode = require('qrcode-terminal');

/********************************************************************
 *  LOGGER
 ********************************************************************/
const logger = P({
  level: 'trace',
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true },
        level: 'trace',
      },
      {
        target: 'pino/file',
        options: { destination: './wa-logs.txt' },
        level: 'trace',
      },
    ],
  },
});
logger.level = 'trace';

/********************************************************************
 *  FLAGS (passados via CLI)
 ********************************************************************/
const doReplies = process.argv.includes('--do-reply');
const usePairingCode = process.argv.includes('--use-pairing-code');

/********************************************************************
 *  CACHE PARA REENTREGAS DE MENSAGENS
 ********************************************************************/
const msgRetryCounterCache = new NodeCache() as CacheStore;

/********************************************************************
 *  MAPA DE ON‑DEMAND (mantido do seu código original)
 ********************************************************************/
const onDemandMap = new Map<string, string>();

/********************************************************************
 *  INTERFACE DE LEITURA DE LINHA (para pairing code)
 ********************************************************************/
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text: string) =>
  new Promise<string>((resolve) => rl.question(text, resolve));

/********************************************************************
 *  PREFIXO CONFIGURÁVEL
 ********************************************************************/
const COMMAND_PREFIX = '/'; // altere para '/' ou outro caractere se desejar


/********************************************************************
 *  INICIALIZAÇÃO DA CONEXÃO
 ********************************************************************/
const App = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

  // versão mais recente do WhatsApp Web
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    // implement to handle retries & poll updates
    getMessage,
  });

  /* -------------------------------------------------
     PARING CODE (caso usePairingCode esteja habilitado)
  ------------------------------------------------- */
  if (usePairingCode && !sock.authState.creds.registered) {
    const phoneNumber = await question('Please enter your phone number:\n');
    const code = await sock.requestPairingCode(phoneNumber);
    console.log(`Pairing code: ${code}`);
  }

  /* -------------------------------------------------
     FUNÇÃO DE ENVIO COM TIPING (mostra "digitando")
  ------------------------------------------------- */
  const sendMessageWTyping = async (jid: string, msg: AnyMessageContent) => {
    await sock.presenceSubscribe(jid);
    await delay(500);
    await sock.sendPresenceUpdate('composing', jid);
    await delay(2000);
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, msg);
  };



/********************************************************************
 *  FUNÇÃO AUXILIAR: extrai comando após o prefixo
 ********************************************************************/
function parseCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;
  return trimmed.slice(COMMAND_PREFIX.length).toLowerCase(); // ex.: "open_group"
}



/********************************************************************
 *  FUNÇÕES DE CONTROLE DO GRUPO (abre/fecha)
 ********************************************************************/
async function openGroup(jid: string) {
  // false → modo livre (todos podem enviar)
  await sock.groupSettingUpdate(jid, 'not_announcement')
  await sock.sendMessageWTyping(jid, {
    text: '🔓 Grupo aberto! Todos podem conversar novamente.',
  });
  console.log(`✅ Grupo ${jid} aberto`);
}

async function closeGroup(jid: string) {
  // true → modo anúncio (só admins podem enviar)
  await sock.groupSettingUpdate(jid, 'announcement')

  await sock.sendMessageWTyping(jid, {
    text: '🔒 Grupo fechado! Apenas administradores podem enviar mensagens.',
  });
  console.log(`✅ Grupo ${jid} fechado`);
}


  /* -------------------------------------------------
     EVENT HANDLER (processa todos os eventos)
  ------------------------------------------------- */
  sock.ev.process(async (events) => {
    /* ---------- CONNECTION UPDATE ---------- */
    if (events['connection.update']) {
      const update = events['connection.update'];
      const { connection, lastDisconnect, qr } = update;

      if (qr) qrcode.generate(qr, { small: true });

      if (connection === 'close') {
        if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
          App(); // reconecta
        } else {
          console.log('Connection closed. You are logged out.');
        }
      }
      console.log('connection update', update);
    }

    /* ---------- CREDENTIALS UPDATE ---------- */
    if (events['creds.update']) await saveCreds();

    /* ---------- MESSAGES UPSET (NOVAS MENSAGENS) ---------- */
    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      console.log('recv messages ', JSON.stringify(upsert, undefined, 2));

      if (upsert.type === 'notify') {
        for (const msg of upsert.messages) {
          const text =
            msg.message?.conversation ??
            msg.message?.extendedTextMessage?.text ??
            '';

          const remoteJid = msg.key.remoteJid!;
          const isGroup = remoteJid.endsWith('@g.us');

          /* ----- COMANDOS COM PREFIXO ----- */
          const cmd = parseCommand(text);
          if (cmd) {
            
              if (cmd === 'open_group') await openGroup(remoteJid);
              else if (cmd === 'close_group') await closeGroup(remoteJid);
              else {
                // comando desconhecido (opcional)
                await sock.sendMessage(remoteJid, {
                  text: `❓ Comando desconhecido: ${cmd}`,
                });
              }
            } else {}
         // comando já tratado → pula o restante do loop
            continue;
          }

          /* ----- COMANDOS SEM PREFIXO (mantém seu código original) ----- */
          // Exemplo de menu (descomente se quiser usar)
          /*
          if (text === 'menu') {
            await sendMessageWTyping(remoteJid,
{
                image: {
                  url:
                    'https://raw.githubusercontent.com/naylor-lab/Zenkai-Ethernal-whatsap.default/refs/heads/main/Files/Menu/homeMenu.jpg',
                },
                caption: '> Menu:\\n\\n/Manager\\n/Services\\n/Help',
              },
            );
          }
          */

          // Auto‑reply padrão (mantém seu comportamento original)
          if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {
            console.log('replying to', remoteJid);
            await sock.readMessages([msg.key]);
            await sendMessageWTyping({ text: 'Hello there!' }, remoteJid);
          }
        }
      }
    }

    /* ---------- OUTROS EVENTOS (mantidos do seu código original) ---------- */
    if (events['messages.update']) {
      console.log(JSON.stringify(events['messages.update'], undefined, 2));
      for (const { key, update } of events['messages.update']) {
        if (update.pollUpdates) {
          const pollCreation: proto.IMessage = {}; // placeholder
          if (pollCreation) {
            console.log(
              'got poll update, aggregation: ',
              getAggregateVotesInPollMessage({
                message: pollCreation,
                pollUpdates: update.pollUpdates,
              })
            );
          }
        }
      }
    }

    if (events['message-receipt.update']) console.log(events['message-receipt.update']);
    if (events['messages.reaction']) console.log(events['messages.reaction']);
    if (events['presence.update']) console.log(events['presence.update']);
    if (events['chats.update']) console.log(events['chats.update']);

    if (events['contacts.update']) {
      for (const contact of events['contacts.update']) {
        if (typeof contact.imgUrl !== 'undefined') {
          const newUrl =
            contact.imgUrl === null
              ? null
              : await sock.profilePictureUrl(contact.id!).catch(() => null);
          console.log(`contact ${contact.id} has a new profile pic: ${newUrl}`);
        }
      }
    }

    if (events['chats.delete']) console.log('chats deleted ', events['chats.delete']);
  });

  return sock;

  /* -------------------------------------------------
     FUNÇÃO REQUIRED BY BAILEYS (RECUPERA MENSAGENS ANTIGAS)
  ------------------------------------------------- */
  async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
    // Implementar caso queira buscar mensagens antigas em algum storage
    return proto.Message.create({ conversation: 'test' });
  }
};

/* -------------------------------------------------
   INICIA O APP
------------------------------------------------- */
App();

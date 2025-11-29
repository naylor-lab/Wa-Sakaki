/********************************************************************
 *  IMPORTS
 ********************************************************************/
import { Boom } from '@hapi/boom';
import NodeCache from '@cacheable/node-cache';
import readline from 'readline';
import makeWASocket, {
  AnyMessageContent,
  CacheStore,
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WAMessageContent,
  WAMessageKey,
} from '@whiskeysockets/baileys';
import P from 'pino';

/********************************************************************
 *  CONSTANTES & CONFIG
 ********************************************************************/
const qrcode = require('qrcode-terminal');               // QR no terminal
const logger = P({                                        // logger simples
  level: 'trace',
  transport: {
    targets: [{ target: 'pino-pretty', options: { colorize: true } }],
  },
});
const COMMAND_PREFIX = '/';                               // pode mudar se quiser
const msgRetryCounterCache = new NodeCache() as CacheStore;

/********************************************************************
 *  FUNÇÕES AUXILIARES
 ********************************************************************/
// leitura de linha (usado só se quiser pairing code)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (txt: string) => new Promise<string>((res) => rl.question(txt, res));

// aceita "/open_group", "open_group", "/close_group" ou "close_group"
function parseCommand(txt: string): string | null {
  const t = txt.trim().toLowerCase();
  if (t.startsWith(COMMAND_PREFIX)) return t.slice(COMMAND_PREFIX.length);
  if (t === 'open_group' || t === 'close_group') return t;
  return null;
}

// envia mensagem simulando "digitando"
async function sendWithTyping(sock: any, jid: string, msg: AnyMessageContent) {
  await sock.presenceSubscribe(jid);
  await delay(500);
  await sock.sendPresenceUpdate('composing', jid);
  await delay(2000);
  await sock.sendPresenceUpdate('paused', jid);
  await sock.sendMessage(jid, msg);
}

/********************************************************************
 *  MAIN – inicia a sessão
 ********************************************************************/
const App = async () => {
  // estado de autenticação (salva credenciais em ./baileys_auth_info)
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

  // versão mais recente do WhatsApp Web
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    getMessage,                     // placeholder (não usado aqui)
  });

  /* ---------- PAIRING CODE (opcional) ---------- */
  if (process.argv.includes('--use-pairing-code') && !sock.authState.creds.registered) {
    const phone = await question('Phone number (inclua DDI): ');
    const code = await sock.requestPairingCode(phone);
    console.log(`Pairing code: ${code}`);
  }

  /* ---------- EVENT HANDLER ÚNICO ---------- */
  sock.ev.process(async (events) => {
    /* ---- CONEXÃO ---- */
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update'];
      if (qr) qrcode.generate(qr, { small: true });

      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('🔄 Reconectando...');
          App();                         // tenta reconectar
        } else {
          console.log('❌ Sessão encerrada (logged out).');
        }
      }
    }

    /* ---- CREDENCIAIS ---- */
    if (events['creds.update']) await saveCreds();

    /* ---- NOVAS MENSAGENS ---- */
    if (events['messages.upsert']) {
      const up = events['messages.upsert'];
      if (up.type !== 'notify') return;

      for (const msg of up.messages) {
        // texto pode vir de diferentes tipos de mensagem
        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          msg.message?.imageMessage?.caption ??
          msg.message?.videoMessage?.caption ??
          '';

        const jid = msg.key.remoteJid!;
        const cmd = parseCommand(text);
        if (!cmd) continue;                 // nada a fazer

        console.log('🟢 Comando:', cmd, '| jid:', jid);

        try {
          if (cmd === 'open_group') {
            await sock.groupSettingUpdate(jid, 'not_announcement');
            await sendWithTyping(sock, jid, { text: '🔓 Grupo aberto! Todos podem conversar.' });
          } else if (cmd === 'close_group') {
            await sock.groupSettingUpdate(jid, 'announcement');
            await sendWithTyping(sock, jid, { text: '🔒 Grupo fechado! Apenas admins podem enviar.' });
          }
        } catch (e) {
          console.error('❗ Erro ao mudar configuração do grupo:', e);
        }//end function 

     switch (cmd) {

     case "allow_modify_group":
    // allow everyone to modify the group's settings
   await sock.groupSettingUpdate(jid, 'unlocked');
   break;

    case "block_modify_group":
// only allow admins to modify the group's settings
await sock.groupSettingUpdate(jid, 'locked');
break;


 case "invite_group":
 //To create link with code use 'https://chat.whatsapp.com/' + code
const code = await sock.groupInviteCode(jid);
await sendWithTyping(sock, jid, { text: 'aqui está o link do grupo:${code}'});

     }

      }
    }
  });

  return sock;
};

/********************************************************************
 *  PLACEHOLDER GET MESSAGE (necessário pela tipagem)
 ********************************************************************/
async function getMessage(_: WAMessageKey): Promise<WAMessageContent | undefined> {
  // caso queira buscar mensagens antigas, implemente aqui.
  return proto.Message.create({ conversation: '' });
}

/********************************************************************
 *  INICIA
 ********************************************************************/
App();
import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, BinaryInfo, CacheStore, delay, DisconnectReason, downloadAndProcessHistorySyncNotification, encodeWAM, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, getHistoryMsg, isJidNewsletter, jidDecode, makeCacheableSignalKeyStore, normalizeMessageContent, PatchedMessageWithRecipientJID, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '@whiskeysockets/baileys'
//import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import P from 'pino'

var qrcode = require('qrcode-terminal');

const logger = P({
  level: "trace",
  transport: {
    targets: [
      {
        target: "pino-pretty", // pretty-print for console
        options: { colorize: true },
        level: "trace",
      },
      {
        target: "pino/file", // raw file output
        options: { destination: './wa-logs.txt' },
        level: "trace",
      },
    ],
  },
})
logger.level = 'trace'

const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// 1️⃣  Prefixo configurável
// ---------------------------------------------------
const COMMAND_PREFIX = '!';   // pode mudar para '/' ou outro caractere

// ---------------------------------------------------
// 2️⃣  Função auxiliar para checar e extrair comando
// ---------------------------------------------------
function parseCommand(text: string): string | null {
  // Remove espaços antes/depois e garante que o texto comece com o prefixo
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;

  // Retorna tudo que vem depois do prefixo, em minúsculas (para comparação case‑insensitive)
  return trimmed.slice(COMMAND_PREFIX.length).toLowerCase();
}


// start a connection
const App = async() => {
        const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
        // fetch latest version of WA Web
        const { version, isLatest } = await fetchLatestBaileysVersion()
        console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

        const sock = makeWASocket({
                version,
                logger,
                auth: {
                        creds: state.creds,
                        /** caching makes the store faster to send/recv messages */
                        keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                msgRetryCounterCache,
                generateHighQualityLinkPreview: true,
                // ignore all broadcast messages -- to receive the same
                // comment the line below out
                // shouldIgnoreJid: jid => isJidBroadcast(jid),
                // implement to handle retries & poll updates
                getMessage
        })


        // Pairing code for Web clients
        if (usePairingCode && !sock.authState.creds.registered) {
                // todo move to QR event
                const phoneNumber = await question('Please enter your phone number:\n')
                const code = await sock.requestPairingCode(phoneNumber)
                console.log(`Pairing code: ${code}`)
        }

        const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
                await sock.presenceSubscribe(jid)
                await delay(500)

                await sock.sendPresenceUpdate('composing', jid)
                await delay(2000)

                await sock.sendPresenceUpdate('paused', jid)

                await sock.sendMessage(jid, msg)
        }

        // the process function lets you process all events that just occurred
        // efficiently in a batch
        sock.ev.process(
                // events is a map for event name => event data
                async(events) => {
                        // something about the connection changed
                        // maybe it closed, or we received all offline message or connection opened
                        if(events['connection.update']) {
                                const update = events['connection.update']
                                const { connection, lastDisconnect, qr } = update

                                if (qr) {
                                qrcode.generate(qr, {small: true});
                                }


                                if(connection === 'close') {
                                        // reconnect if not logged out
                                        if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
                                                App()
                                        } else {
                                                console.log('Connection closed. You are logged out.')
                                        }
                                }
                                console.log('connection update', update)
                        }

                        // credentials updated -- save them
                        if(events['creds.update']) {
                                await saveCreds()
                        }

                        if(events['labels.association']) {
                                console.log(events['labels.association'])
                        }


                        if(events['labels.edit']) {
                                console.log(events['labels.edit'])
                        }

                        if(events.call) {
                                console.log('recv call event', events.call)
                        }

                        // history received
                        if(events['messaging-history.set']) {
                                const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
                                if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
                                        console.log('received on-demand history sync, messages=', messages)
                                }
                                console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
                        }

                        // ---------------------------------------------------
// 3️⃣  Dentro do handler de mensagens.upsert
// ---------------------------------------------------
if (events['messages.upsert']) {
  const upsert = events['messages.upsert'];
  console.log('recv messages ', JSON.stringify(upsert, undefined, 2));

  if (upsert.type === 'notify') {
    for (const msg of upsert.messages) {
      // Captura o texto da mensagem (simples ou extended)
      const text = msg.message?.conversation ??
                   msg.message?.extendedTextMessage?.text ??
                   '';

      // ----------------------------------------------
      // 3.1️⃣  Primeiro tratamos os comandos com prefixo
      // ----------------------------------------------
      const cmd = parseCommand(text);
      if (cmd) {
        // Exemplo de ID do grupo que será aberto/fechado.
        // Substitua pelo JID real do seu grupo (ex.: '1234567890-123456@g.us')
        const TARGET_GROUP_JID = 'SEU_GRUPO_ID@g.us';

        switch (cmd) {
          case 'open_group':
            // Envia uma mensagem ao grupo indicando que ele foi "aberto"
            await sock.sendMessage(TARGET_GROUP_JID, {
              text: '🔓 Grupo aberto! Agora todos podem conversar.',
            });
            console.log('Comando open_group executado');
            break;

          case 'close_group':
            // Envia uma mensagem ao grupo indicando que ele foi "fechado"
            await sock.sendMessage(TARGET_GROUP_JID, {
              text: '🔒 Grupo fechado! Mensagens serão ignoradas até reabrir.',
            });
            console.log('Comando close_group executado');
            break;

          // Caso queira manter outros comandos com prefixo, adicione aqui
          default:
            // Se o comando não for reconhecido, opcionalmente avise o usuário
            await sock.sendMessage(msg.key.remoteJid!, {
              text: `❓ Comando desconhecido: ${cmd}`,
            });
            break;
        }

        // Depois de tratar o comando, continue para a próxima mensagem
        continue;
      }

      // -------------------------------------------------
      // 3.2️⃣  Tratamento dos comandos *sem* prefixo (mantém o seu código atual)
      // -------------------------------------------------
      /*if (text === 'menu') {
        await sendMessageWTyping(
          {
            
          },
          msg.key.remoteJid
        );
      }*/

      // ... (restante do seu código original, como requestPlaceholder, onDemandHistSync, auto‑reply etc.)

      if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {
        console.log('replying to', msg.key.remoteJid);
        await sock!.readMessages([msg.key]);
        await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!);
      }
    }
  }
}

                        // messages updated like status delivered, message deleted etc.
                        if(events['messages.update']) {
                                console.log(
                                        JSON.stringify(events['messages.update'], undefined, 2)
                                )

                                for(const { key, update } of events['messages.update']) {
                                        if(update.pollUpdates) {
                                                const pollCreation: proto.IMessage = {} // get the poll creation message somehow
                                                if(pollCreation) {
                                                        console.log(
                                                                'got poll update, aggregation: ',
                                                                getAggregateVotesInPollMessage({
                                                                        message: pollCreation,
                                                                        pollUpdates: update.pollUpdates,
                                                                })
                                                        )
                                                }
                                        }
                                }
                        }

                        if(events['message-receipt.update']) {
                                console.log(events['message-receipt.update'])
                        }

                        if(events['messages.reaction']) {
                                console.log(events['messages.reaction'])
                        }

                        if(events['presence.update']) {
                                console.log(events['presence.update'])
                        }

                        if(events['chats.update']) {
                                console.log(events['chats.update'])
                        }

                        if(events['contacts.update']) {
                                for(const contact of events['contacts.update']) {
                                        if(typeof contact.imgUrl !== 'undefined') {
                                                const newUrl = contact.imgUrl === null
                                                        ? null
                                                        : await sock!.profilePictureUrl(contact.id!).catch(() => null)
                                                console.log(
                                                        `contact ${contact.id} has a new profile pic: ${newUrl}`,
                                                )
                                        }
                                }
                        }

                        if(events['chats.delete']) {
                                console.log('chats deleted ', events['chats.delete'])
                        }
                }
        )

        return sock

        async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
          // Implement a way to retreive messages that were upserted from messages.upsert
                        // up to you

                // only if store is present
                return proto.Message.create({ conversation: 'test' })
        }
}

App()

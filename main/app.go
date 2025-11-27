package main

import (
        "context"
        "fmt"
        "os"
        "os/signal"
        "syscall"

        // ---------- WhatsMeow ----------
        "go.mau.fi/whatsmeow"
        "go.mau.fi/whatsmeow/store/sqlstore"
        "go.mau.fi/whatsmeow/types/events"
        waLog "go.mau.fi/whatsmeow/util/log"

        // ---------- QR code ----------
        "github.com/mdp/qrterminal/v3"

        // ---------- Driver SQLite ----------
        _ "github.com/mattn/go-sqlite3"
)

// -----------------------------------------------------------------------------
// Manipulador de eventos da WhatsMeow
func eventHandler(client *whatsmeow.Client) func(interface{}) {
        return func(evt interface{}) {
                switch v := evt.(type) {

                case *events.Message:
                        // Texto bruto da mensagem (se houver)
                        text := v.Message.GetConversation()
                        if text == "" {
                                // Mensagens de mídia não são relevantes aqui
                                return
                        }

                        // Só nos interessam mensagens vindas de grupos
                        if !v.Message.Chat.IsGroup {
                                return
                        }

                        fmt.Printf("Mensagem recebida no grupo %s: %s\n",
                                v.Message.Chat.String(), text)

                        // -------------------------------------------------------------
                        // Detecta os comandos /close e /open
                        switch text {
                        case "/close":
                                err := client.SetGroupAnnouncement(context.Background(),
                                        v.Message.Chat, true) // true = modo “anúncio” (fechado)
                                if err != nil {
                                        fmt.Println("❌ Falha ao fechar o grupo:", err)
                                } else {
                                        fmt.Println("✅ Grupo fechado (apenas admins podem falar).")
                                }
                        case "/open":
                                err := client.SetGroupAnnouncement(context.Background(),
                                        v.Message.Chat, false) // false = modo normal (aberto)
                                if err != nil {
                                        fmt.Println("❌ Falha ao abrir o grupo:", err)
                                } else {
                                        fmt.Println("✅ Grupo aberto (todos podem falar).")
                                }
                        }
                        // -------------------------------------------------------------
                }
        }
}

// -----------------------------------------------------------------------------
// Função principal
func main() {
        // Log do banco (nível DEBUG opcional)
        dbLog := waLog.Stdout("Database", "DEBUG", true)

        // Contexto padrão
        ctx := context.Background()

        // Cria o container de armazenamento usando SQLite
        container, err := sqlstore.New(
                ctx,
                "sqlite3",                                 // driver registrado acima
                "file:examplestore.db?_foreign_keys=on",   // DSN
                dbLog,
        )
        if err != nil {
                panic(err)
        }

        // Obtém o primeiro dispositivo armazenado (ou cria um novo)
        deviceStore, err := container.GetFirstDevice(ctx)
        if err != nil {
                panic(err)
        }

        // Log do cliente WhatsMeow
        clientLog := waLog.Stdout("Client", "DEBUG", true)
        client := whatsmeow.NewClient(deviceStore, clientLog)

        // Registra o handler de eventos (passando o client para poder chamar APIs)
        client.AddEventHandler(eventHandler(client))

        // -------------------------------------------------------------------------
        // Primeiro acesso → login via QR code
        if client.Store.ID == nil {
                qrChan, _ := client.GetQRChannel(context.Background())

                // Conecta (dispara o evento de QR)
                if err = client.Connect(); err != nil {
                        panic(err)
                }

                // Processa os eventos de QR ou de login concluído
                for evt := range qrChan {
                        if evt.Event == "code" {
                                // Exibe o QR no terminal usando blocos “half”
                                qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
                                fmt.Println("\nEscaneie o QR acima com o WhatsApp.")
                        } else {
                                fmt.Println("Evento de login:", evt.Event)
                        }
                }
        } else {
                // Sessão já existente – só conecta
                if err = client.Connect(); err != nil {
                        panic(err)
                }
        }

        // -------------------------------------------------------------------------
        // Mantém o programa vivo até receber Ctrl+C (SIGINT/SIGTERM)
        c := make(chan os.Signal, 1)
        signal.Notify(c, os.Interrupt, syscall.SIGTERM)
        <-c

        // Desconecta antes de encerrar
        client.Disconnect()
}
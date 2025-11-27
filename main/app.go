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
	// Importação em branco apenas para registrar o driver com database/sql.
	_ "github.com/mattn/go-sqlite3"
)

// -----------------------------------------------------------------------------
// Manipulador de eventos da WhatsMeow
func eventHandler(evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		fmt.Println("Mensagem recebida:", v.Message.GetConversation())
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
		"sqlite3",                                 // nome do driver (registrado acima)
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

	// Registra o handler de eventos
	client.AddEventHandler(eventHandler)

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

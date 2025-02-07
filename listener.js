/**
 * Handles websocket notifications developer by clenildon ferreira
 * LICENSE MIT
 */
import WebSocket from 'ws';
import logger from './logger.js';
import ns from './ns.js';
import callEventsReport from './call-events-report.js';
import axios from 'axios';

const CALL_EVENTS_REPORT_NOTIFICATION_SOURCE = 'call-events-report';
const PING_INTERVAL_MS = 8000;
const RECONNECT_DELAY_MS = 10000;

const log = logger.instance();

function json(o) {
    return JSON.stringify(o, null, 2);
}

class Listener {
    #channel;
    #subscription;
    #ws;
    #reconnectTimer;
    #isShuttingDown;
    #queue; // Fila para gerenciar as mensagens a serem enviadas
    #isProcessing; // Controle do status de processamento da fila

    constructor() {
        this.#channel = null;
        this.#subscription = null;
        this.#ws = null;
        this.#reconnectTimer = null;
        this.#isShuttingDown = false;
        this.#queue = []; // Inicializa a fila
        this.#isProcessing = false; // Inicializa como não estar processando
    }

    async connect() {
        try {
            this.#cancelReconnectAttempt();
            log.debug('Listener - connect(): creating notification');
            this.#channel = (await ns.createNotificationChannel()).data;
            log.info(`Listener - connect(): created notification channel ${this.#channel.channelId}`);

            log.debug('Listener - connect(): creating subscription');
            this.#subscription = (await callEventsReport.createSubscription(this.#channel.channelId)).data;
            log.info(`Listener - connect(): created subscription ${this.#subscription.items[0].id}`);

            this.#ws = new WebSocket(this.#channel.channelData.channelURL);
            this.#ws.on('open', this.#onSocketOpen.bind(this));
            this.#ws.on('close', this.#onSocketClose.bind(this));
            this.#ws.on('error', this.#onSocketError.bind(this));
            this.#ws.on('message', this.#onSocketMessage.bind(this));
        } catch (e) {
            log.error(`Listener - connect() failed: ${e}`);
            this.#scheduleReconnectAttempt();
        }
    }

    disconnect(isShuttingDown) {
        if (isShuttingDown) {
            this.#isShuttingDown = true;
            this.#cancelReconnectAttempt();
        }

        if (this.#ws) {
            log.info('Listener - disconnect(): closing websocket');
            this.#ws.removeAllListeners();
            if (this.#ws.pingInterval) {
                clearInterval(this.#ws.pingInterval);
            }
            try { 
                this.#ws.close(); 
            } catch (e) { /* ignore */ }
            this.#ws = null;
        }

        if (this.#subscription) {
            log.info('Listener - disconnect(): deleting subscription');
            callEventsReport.deleteSubscription(this.#channel.channelId).catch(() => {});
            this.#subscription = null;
        }

        if (this.#channel) {
            log.info('Listener - disconnect(): deleting notification channel');
            ns.deleteNotificationChannel(this.#channel.channelId).catch(() => {});
            this.#channel = null;
        }
    }

    #scheduleReconnectAttempt(immediateReconnect) {
        if (this.#reconnectTimer == null && !this.#isShuttingDown) {
            this.disconnect(false);
            this.#reconnectTimer = setTimeout(() => this.connect(), immediateReconnect ? 0 : RECONNECT_DELAY_MS);
        }
    }

    #cancelReconnectAttempt() {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    #onSocketOpen() {
        log.info(`Listener - connected to ${this.#ws.url}`);
        // Regularly ping the websocket server peer...
        this.#ws.pingInterval = setInterval(() => {
            const ping = { sequence: ++this.#ws.pingSequence };
            this.#ws.ping(JSON.stringify(ping));
            // Reconnect after 3 missed pong responses from the websocket peer
            const pendingPongs = this.#ws.pingSequence - this.#ws.pongSequence;
            if (pendingPongs > 3) {
                log.error('Listener - websocket liveness check failed: will attempt to reconnect...');
                this.#scheduleReconnectAttempt();
            }
        }, PING_INTERVAL_MS);
    }

    #onSocketClose(code, reason) {
        log.info(`Listener - websocket closed with code=${code} and reason=[${reason}]`);
        this.#scheduleReconnectAttempt();
    }

    #onSocketError(e) {
        log.error(`Listener - websocket error: ${e}`);
        this.#scheduleReconnectAttempt();
    }

    async #onSocketMessage(data) {
        try {
            const msg = JSON.parse(data);
            log.debug(`Listener - got message: ${json(msg)}`);

            if (msg.data.source === CALL_EVENTS_REPORT_NOTIFICATION_SOURCE) {
                // Adiciona a chamada na fila
                this.enqueue(msg.data.content.conversationSpaceId);
            }
        } catch (e) {
            log.error(`Listener - message handler got error ${e}`);
        }
    }

    enqueue(conversationSpaceId) {
        this.#queue.push(conversationSpaceId); // Adiciona o ID da conversa à fila
        this.processQueue(); // Inicia o processamento
    }

    async processQueue() {
        if (this.#isProcessing) return; // Se já está processando, sai
        this.#isProcessing = true; // Marca que está processando

        while (this.#queue.length > 0) {
            const conversationSpaceId = this.#queue.shift(); // Remove o primeiro item da fila
            await this.handleCallEvent(conversationSpaceId); // Processa a chamada e envia ao webhook
        }

        this.#isProcessing = false; // Reseta a flag após o processamento
    }

    async handleCallEvent(conversationSpaceId) {
        try {
            const response = await callEventsReport.fetchCallEvents(conversationSpaceId);
            const callDetails = response.data;
            log.info(JSON.stringify(callDetails, null, 2));
            // Envio dos detalhes para o webhook
            await this.#sendToWebhook(callDetails);
        } catch (e) {
            log.error(`Listener - failed to fetch call events report ${conversationSpaceId}: ${e}`);
        }
    }

    async #sendToWebhook(data) {
        try {
            const webhookUrl = 'https://n8nwebhook.cearatec.cloud/webhook/nps02_teste'; // URL do webhook
            await axios.post(webhookUrl, data);
            log.info('Data sent to webhook successfully');
        } catch (e) {
            log.error(`Failed to send data to webhook: ${e}`);
        }
    }
}

export { Listener };

import winston from 'winston';
import axios from 'axios';
import * as axioslog from 'axios-logger';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// Definir __dirname manualmente
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Criar pasta de logs se não existir
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Configure axios using axios-logger to emit to winston
axios.interceptors.request.use(axioslog.requestLogger, axioslog.errorLogger);
axios.interceptors.response.use(axioslog.responseLogger, axioslog.errorLogger);
axioslog.setGlobalConfig({
    prefixText: false,
    dateFormat: false,
    method: true,
    url: true,
    params: process.env.LOG_LEVEL == 'debug',
    data: process.env.LOG_LEVEL == 'debug',
    status: true,
    statusText: false,
    headers: false,
    logger: instance().debug.bind(this)
});

function instance() {
    const { combine, timestamp, printf, colorize, align } = winston.format;

    // Criar um novo arquivo de log para cada requisição
    const logFilePath = path.join(logsDir, `call_${Date.now()}.log`);

    return winston.createLogger({
        level: process.env.LOG_LEVEL,
        format: combine(
            colorize(),
            timestamp({ format: 'HH:mm:ss.SSS' }),
            printf(log => `[${log.timestamp}] ${log.level} - ${log.message}`)
        ),
        transports: [
            new winston.transports.Console(), // Mantém o log no terminal
            new winston.transports.File({ filename: logFilePath }) // Adiciona log em arquivo
        ]
    });
}

export default {
    instance
};

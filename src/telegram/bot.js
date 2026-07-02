import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';
import { installTelegramRedaction } from './redact.js';

export const bot = installTelegramRedaction(new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: process.env.NODE_ENV === 'test' ? false : true,
}));

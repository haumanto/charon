import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

const SINK_MODE = process.env.CHARON_SINK_MODE === 'true';

class StubBot {
  async sendMessage() { return { message_id: 0 }; }
  async answerCallbackQuery() { return true; }
  async editMessageText() { return true; }
  async editMessageReplyMarkup() { return true; }
  async deleteMessage() { return true; }
  on() {}
  onText() {}
  removeAllListeners() {}
}

export const bot = SINK_MODE
  ? new StubBot()
  : new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

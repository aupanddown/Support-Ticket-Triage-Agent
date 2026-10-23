import { detectScript, fallbackLanguage, type ReplyLanguage } from "../language.js";
import type { Ticket } from "../schemas.js";
import { customerText } from "./replyChecks.js";

/** Pre-approved replies, used whenever the model's draft cannot be trusted. They never promise money. */
const SAFE_REPLIES: Record<ReplyLanguage, { billing: string; general: string }> = {
  en: {
    billing:
      "Hi, thank you for your patience, and I'm sorry for the trouble with your payment. " +
      "I have passed your case to our Billing team as a priority so they can review every charge on your account " +
      "and your plan status. A team member will contact you directly with an update.",
    general:
      "Hi, thank you for contacting us. Your request has been passed to the right team, " +
      "and a team member will get back to you as soon as possible.",
  },
  th: {
    billing:
      "สวัสดีครับ ขออภัยในความไม่สะดวกเรื่องการชำระเงินครับ เราได้ส่งเรื่องของคุณให้ทีมการเงินตรวจสอบเป็นกรณีเร่งด่วนแล้ว " +
      "ทีมจะตรวจสอบทุกรายการที่เรียกเก็บและสถานะแพ็กเกจของคุณ และจะติดต่อกลับโดยตรงครับ",
    general:
      "สวัสดีครับ ขอบคุณที่ติดต่อเรา เราได้ส่งเรื่องของคุณให้ทีมที่เกี่ยวข้องแล้ว และเจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุดครับ",
  },
};

export type SafeReplyKind = keyof (typeof SAFE_REPLIES)[ReplyLanguage];

export function safeReply(language: ReplyLanguage, kind: SafeReplyKind): string {
  return SAFE_REPLIES[language][kind];
}

/** The language for a safe reply to this ticket: Thai for Thai tickets, English otherwise. */
export function safeReplyLanguage(ticket: Ticket): ReplyLanguage {
  return fallbackLanguage(detectScript(customerText(ticket))) ?? "en";
}

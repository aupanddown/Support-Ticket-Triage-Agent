# Sample output

Real results for the three sample tickets: the first run of `npm run eval -- --runs 3` with `gpt-5.4-mini` on 2026-10-23, the same agent and policy as `npm run triage`. Model output varies between runs; in this run the T3 reply still suggests a browser check although the customer uses the desktop app, which the eval reports as a failed reply check.

## T1: triple charge, presentation in 2 hours

```json
{
  "ticket_id": "T1",
  "urgency": "critical",
  "extracted": {
    "product": "billing",
    "issue_types": [
      "billing_dispute",
      "billing_question",
      "access_problem"
    ],
    "sentiment": "angry",
    "language": "en"
  },
  "decision": "escalate_to_human",
  "route_team": "Billing",
  "follow_up_teams": [],
  "kb_articles_used": [
    "KB-201",
    "KB-202",
    "KB-203"
  ],
  "customer_reply_draft": "I'm sorry this is happening, especially with your presentation in 2 hours. I can see your Pro upgrade payment was captured three times, but your account is still on Free and the Pro plan did not activate. Our billing team needs to review the charges and get the plan activation issue sorted out. They will contact you directly.\n\nFor reference, Pro includes the export features you need, and those become available as soon as the plan is active. I've also noted that you said you may dispute the charges with your bank if this is not resolved by end of day.\n\nPlease do not retry the upgrade again right now. Our billing team will review all three transactions and the failed activation together.",
  "internal_note": "Customer attempted Pro upgrade 3 times today. Billing data shows three captured charges (TX-9001 $29.99 card 4242, TX-9002 $29.99 card 5511, TX-9003 $29.99 card 5511) and pending_upgrade status activation_failed; current plan remains Free. Public status page and US internal monitoring are operational, so this is not an outage. Customer is highly upset and needs Pro export features within 2 hours for a presentation; they also threatened to dispute all charges with their bank by end of day. Route to Billing as critical billing issue with access impact and chargeback threat.",
  "confidence": 0.98,
  "guardrails_applied": []
}
```

## T2: Enterprise outage in Thailand

```json
{
  "ticket_id": "T2",
  "urgency": "critical",
  "extracted": {
    "product": "platform",
    "issue_types": [
      "outage",
      "access_problem"
    ],
    "sentiment": "negative",
    "language": "th"
  },
  "decision": "escalate_to_human",
  "route_team": "Engineering_Incident",
  "follow_up_teams": [
    "Support"
  ],
  "kb_articles_used": [
    "KB-301",
    "KB-302",
    "KB-401"
  ],
  "customer_reply_draft": "ขอบคุณที่แจ้งครับ ตอนนี้เราได้รับข้อมูลแล้วว่าเป็นปัญหาใน region Asia ที่กระทบการเข้าใช้งานของหลายคนในทีม และมี error 500 แม้ลองหลายเบราว์เซอร์แล้ว ข้อมูลที่เช็คได้ตอนนี้บอกว่า status page ยังแสดงว่า all systems operational แต่เราพบสัญญาณว่ามีปัญหาในระบบจริง ทีมวิศวกรรมของเรากำลังตรวจสอบเรื่องนี้อยู่และจะติดต่อกลับโดยเร็วที่สุด\n\nผมเข้าใจว่าคุณมี demo กับลูกค้ารายใหญ่บ่ายนี้และมีความเสี่ยงต่อดีล ทีมได้รับทราบความเร่งด่วนนี้แล้วครับ",
  "internal_note": "Enterprise customer in Thailand/Asia, 45 seats, daily usage. Thread shows 500 errors for multiple users across multiple browsers, impacting the whole team; customer has an afternoon demo and says the deal may be lost if service is not restored. Public status page says all systems operational, but internal monitoring shows degraded Web App/API in Asia with elevated 5xx errors since ~2 hours ago. Enterprise SLA notes 1 hour response target for critical issues. First critical issue on account. Escalate to Engineering_Incident; Support may assist with comms.",
  "confidence": 0.98,
  "guardrails_applied": []
}
```

## T3: dark mode question, bug and feature request

```json
{
  "ticket_id": "T3",
  "urgency": "low",
  "extracted": {
    "product": "appearance",
    "issue_types": [
      "how_to",
      "feature_request",
      "bug"
    ],
    "sentiment": "neutral",
    "language": "en"
  },
  "decision": "auto_respond",
  "route_team": null,
  "follow_up_teams": [
    "Product"
  ],
  "kb_articles_used": [
    "KB-101",
    "KB-102"
  ],
  "customer_reply_draft": "Hi Taylor, thanks for checking back and for trying System Default on your Mac.\n\nA couple of things here:\n1. The app currently offers Light and System Default on all plans, including Pro. There is not a separate Dark toggle yet.\n2. If you choose System Default, the app should follow your Mac's appearance setting. If it is still showing light after you switched your Mac to dark mode, please try:\n- Fully quit and reopen the app after changing your Mac theme\n- Make sure you are on the latest app version\n\nIf you are using a browser too, a browser extension can sometimes force a light theme.\n\nFor scheduling dark mode: the app does not have its own schedule yet, but you can use your operating system's automatic appearance switch. On macOS, go to System Settings > Appearance > Auto to switch between light and dark based on time of day.\n\nThanks for the feature idea as well. I've passed that along to our Product team.\n\nHelp articles:\nhttps://help.company.com/articles/appearance-settings\nhttps://help.company.com/articles/schedule-theme",
  "internal_note": "Customer on Pro plan, macOS desktop app, asks about dark mode, says only Light and System Default are visible, and reports System Default does not switch to dark after setting macOS dark mode. Also requested scheduled dark mode/auto-switch at 6pm. KB says Light and System Default are available on all plans; no separate Dark toggle; System Default should follow OS theme; troubleshooting is to fully quit/reopen and update app. No billing or access issue. Treat as how-to plus possible bug if System Default still does not follow OS theme; route feature request to Product.",
  "confidence": 0.96,
  "guardrails_applied": []
}
```

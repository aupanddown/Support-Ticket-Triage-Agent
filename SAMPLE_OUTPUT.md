# Sample output

Real results for the three sample tickets: the first run of `npm run eval -- --runs 3` with `gpt-5.4-mini`, the same agent and policy as `npm run triage`. Model output varies between runs. In this run two checks failed: the T1 reply says the charges are "captured transactions, not just pending authorizations", which is correct but contains the word the check looks for; and the T2 internal note does not mention the 1-hour response SLA.

## T1: triple charge, presentation in 2 hours

```json
{
  "ticket_id": "T1",
  "urgency": "critical",
  "extracted": {
    "product": "billing",
    "product_detail": "Pro plan upgrade",
    "issue_types": [
      "billing_dispute",
      "billing_question"
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
  "customer_reply_draft": "I'm sorry for the trouble here, especially with your presentation in 2 hours.\n\nI've escalated this to our billing team to review the three Pro upgrade charges and the failed plan activation. They can check the captured payments and help with the plan activation issue. They'll contact you as soon as possible.\n\nFrom what I can see, your account is still on Free, and the three $29.99 charges are captured transactions, not just pending authorizations. I can also see that the Pro upgrade activation did not complete.\n\nPlease let us know if you contact your bank about these charges, so the billing team can review everything together. I can't promise a reversal or a specific fix time, but I've marked the urgency and the deadline you mentioned.",
  "internal_note": "Free-plan customer attempted Pro upgrade 3 times today. Billing data shows pending_upgrade activation_failed and three captured charges: TX-9001 ($29.99, card 4242, 3 hours ago), TX-9002 ($29.99, card 5511, 2 hours ago), TX-9003 ($29.99, card 5511, 1 hour ago). Account still on Free. Customer says they need Pro export features for a presentation in 2 hours and threatens to dispute all charges with their bank by end of day. Escalate to Billing urgently for captured duplicate charges/plan activation failure and to advise on any next step; do not promise refund or reversal.",
  "confidence": 0.99,
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
    "product_detail": "Web App (Asia region)",
    "issue_types": [
      "outage",
      "access_problem"
    ],
    "sentiment": "negative",
    "language": "th"
  },
  "decision": "escalate_to_human",
  "route_team": "Engineering_Incident",
  "follow_up_teams": [],
  "kb_articles_used": [],
  "customer_reply_draft": "ขอบคุณที่แจ้งเข้ามาครับ ตอนนี้ทีมวิศวกรรมของเรากำลังตรวจสอบปัญหาที่อาจส่งผลต่อผู้ใช้ใน region Asia อยู่ แม้หน้า status จะยังขึ้นว่า all systems operational อยู่ก็ตาม\n\nจากที่คุณแจ้งมา ทั้ง error 500, ทดลองหลายเบราว์เซอร์แล้ว, และเพื่อนร่วมงานก็เข้าไม่ได้ด้วย แปลว่ากระทบหลายคนในบัญชีนี้จริง และผมได้ส่งเรื่องต่อให้ทีมของเราแล้ว โดยเฉพาะกรณีที่คุณมี demo กับลูกค้ารายใหญ่ช่วงบ่ายวันนี้ ทีมจะรีบตรวจสอบและติดต่อกลับโดยตรงครับ",
  "internal_note": "Enterprise customer in Thailand, 45 seats, 8 months tenure. Reports site-wide access failure with HTTP 500 for multiple browsers and multiple coworkers in Asia region; demo with a large customer this afternoon and risk of losing the deal if unresolved. Public status page still says all systems operational, but internal monitoring shows Asia Web App and API degraded with 5xx errors since about 2 hours ago. Billing is paid and unrelated. This is the first critical issue on the account. Escalate to Engineering Incident immediately; acknowledge the deadline and that the team has been informed. No KB article used.",
  "confidence": 0.97,
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
    "product_detail": "Dark mode / theme settings in macOS desktop app",
    "issue_types": [
      "how_to",
      "bug",
      "feature_request"
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
  "customer_reply_draft": "Hey Taylor, thanks for checking and for the extra details. Yes, dark mode is supported through Settings > Appearance, but there isn't a separate Dark toggle on Pro or any other plan. The available options are Light and System Default.\n\nSince you're on the macOS desktop app and System Default is still showing light after you switched your Mac to dark mode, please try:\n1. Fully quit and reopen the app after changing your Mac theme\n2. Make sure you're on the latest app version\n\nIf it still stays light after that, the behavior may be a bug, and I've passed the possible bug you described to our product team.\n\nFor your scheduling question: there isn't a built-in dark mode schedule in the app yet. On macOS, you can use System Settings > Appearance > Auto to switch between light and dark automatically based on time of day. I've also passed your feature request for scheduled dark mode to our product team.\n\nHelp article:\nhttps://help.company.com/articles/appearance-settings\nhttps://help.company.com/articles/schedule-theme",
  "internal_note": "Pro customer (5 months, daily active, macOS desktop app). Thread asks about dark mode availability, System Default not switching to dark on macOS, and a feature request for scheduled dark mode. KB-101 says only Light and System Default are available on all plans, System Default should follow OS theme, and suggests fully quitting/reopening the app and updating; KB-102 says no built-in schedule yet and suggests macOS Auto as workaround. No billing or access issue. Product should review possible bug behavior where System Default does not switch to dark after OS theme change. No deadline mentioned.",
  "confidence": 0.95,
  "guardrails_applied": []
}
```

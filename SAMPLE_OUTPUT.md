# Sample output

Real results for the three sample tickets: the first run of `npm run eval -- --runs 3` with `gpt-5.4-mini` on 2026-10-23, the same agent and policy as `npm run triage`. Model output varies between runs. In this run two eval checks failed: the T2 reply tells the customer the issue is not yet on the status page (the prompt asks only to say the team is investigating), and T3 urgency is `medium` instead of the expected `low`.

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
    "KB-202",
    "KB-201",
    "KB-203"
  ],
  "customer_reply_draft": "I'm sorry for the trouble here. Our billing team is handling this now, and they'll contact you directly. I can see your Pro upgrade attempts were captured but the plan activation did not complete, so your account is still on Free right now.\n\nI've flagged the urgency, including your presentation in 2 hours and your message that you may dispute the charges by end of day. Our billing team can review the captured charges and check the failed activation on your account.\n\nFor reference, Pro includes the export features you need, and it becomes available as soon as the plan is active. Our billing team will follow up as soon as possible.",
  "internal_note": "Customer tried to upgrade to Pro 3 times today. Billing history shows current plan Free, pending upgrade activation_failed, with three captured charges: TX-9001 $29.99 (3 hours ago, card 4242), TX-9002 $29.99 (2 hours ago, card 5511), TX-9003 $29.99 (1 hour ago, card 5511). KB says failed upgrade attempts can create pending authorizations, but here the transactions are captured, not pending, and Billing can review charges and activate plan manually. Customer is angry, needs Pro export features for a presentation in 2 hours, and threatened to dispute all charges by end of day.",
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
    "product_detail": "Web App and API (Asia region)",
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
  "kb_articles_used": [
    "KB-301",
    "KB-302",
    "KB-401"
  ],
  "customer_reply_draft": "ขอบคุณที่แจ้งครับ ตอนนี้เรากำลังให้ทีมวิศวกรรมตรวจสอบปัญหาที่อาจกระทบผู้ใช้ในภูมิภาค Asia อยู่ครับ\n\nจากที่คุณแจ้งมา อาการ error 500 เกิดกับหลายเครื่องและหลายเบราว์เซอร์ และเพื่อนร่วมงานก็เข้าไม่ได้เหมือนกัน รวมถึงตอนนี้มี demo กับลูกค้ารายใหญ่ในวันนี้ เราได้แจ้งเรื่องความเร่งด่วนนี้ให้ทีมแล้วครับ\n\nแม้หน้า status จะยังแสดงว่า all systems operational แต่กรณีของ regional issue บางครั้งอาจยังไม่ถูกประกาศบนหน้า status ทันที ทีมของเราจะตรวจสอบให้และติดต่อกลับโดยเร็วที่สุดครับ",
  "internal_note": "Enterprise customer in Thailand/Asia, 45 seats, daily usage. Thread shows multi-user access failure with HTTP 500 across browsers and devices for ~2 hours, affecting a same-day demo and risking a deal. Public status page says all systems operational, but internal monitoring shows Asia Web App and API degraded with elevated 5xx from ap-southeast load balancer since about 2 hours ago. Enterprise SLA: 1 hour response target for critical issues. First critical issue on this account. Route to Engineering_Incident; customer should be contacted.",
  "confidence": 0.98,
  "guardrails_applied": []
}
```

## T3: dark mode question, bug and feature request

```json
{
  "ticket_id": "T3",
  "urgency": "medium",
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
  "customer_reply_draft": "Hi Taylor, thanks for checking and for the extra detail.\n\nThere isn't a separate Dark toggle in the app. On all plans, the available options are Light and System Default. System Default should follow your Mac theme, so if your Mac is set to dark mode the app should also appear dark.\n\nIf it is still showing light after you switch to System Default, please try these steps:\n1. Fully quit the app and open it again after changing your Mac appearance setting.\n2. Make sure you're on the latest version of the app.\n\nFor scheduling, the app doesn't have its own built-in dark mode schedule yet. The workaround on macOS is to set your Mac to Appearance > Auto, which switches light/dark automatically based on time of day.\n\nHelp article: https://help.company.com/articles/appearance-settings\n\nRelated article: https://help.company.com/articles/schedule-theme\n\nAnd yes, I've passed along your request for a scheduled dark mode option to our Product team.",
  "internal_note": "Customer on Pro plan, 5 months, daily active, macOS desktop app, no prior tickets. Thread includes a how-to question about dark mode, a possible bug: after selecting System Default and setting macOS to dark, the app still shows light theme, and a feature request for scheduled dark mode. KB confirms only Light and System Default are available on all plans, System Default should follow OS theme, and there is no built-in schedule yet. No billing/account issue. Recommend auto-response for the how-to; follow up Product on the feature request, with note that the theme not switching may be a bug if the troubleshooting steps fail.",
  "confidence": 0.92,
  "guardrails_applied": []
}
```

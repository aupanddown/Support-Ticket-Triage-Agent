# Sample output

Real results for the three sample tickets: the first run of `npm run eval -- --runs 3` with `gpt-5.4-mini` on 2026-10-24, the same agent and policy as `npm run triage`. Model output varies between runs. In this run two reply checks failed: the T1 reply uses the word "pending" for the duplicate charges, and the T3 reply says the feature request was passed to the product team but does not say the same for the possible bug.

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
  "customer_reply_draft": "I'm sorry for the trouble here. I can see the Pro upgrade was attempted three times and all three payments were captured, but your account is still on Free because the plan activation did not complete.\n\nThis has been passed to our billing team to review the charges and your upgrade. They will contact you directly and can review each transaction on your account. I've also noted your deadline, since you need Pro export features for a presentation in 2 hours.\n\nFor reference, Pro includes the export features you need, and it becomes available as soon as the plan is active.\n\nArticle links:\nPayment failed when upgrading your plan: https://help.company.com/articles/payment-failed-upgrade\nDuplicate or pending charges on your statement: https://help.company.com/articles/duplicate-charges\nWhat is included in the Pro plan: https://help.company.com/articles/pro-plan-features\n\nIf you also contact your bank, please let us know so the billing team can review everything together.",
  "internal_note": "Customer on Free plan attempted Pro upgrade 3 times today. Billing lookup shows three captured charges: TX-9001 ($29.99, card 4242, 3 hours ago), TX-9002 ($29.99, card 5511, 2 hours ago), TX-9003 ($29.99, card 5511, 1 hour ago). Pending upgrade status: activation_failed; plan still Free. Customer reports 3 captured charges, no refund, no Pro access, and threatened to dispute all charges with bank by end of day. Needs Pro export features for presentation in 2 hours. Public status page and US components operational. This is a billing dispute with urgent deadline; route to Billing.",
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
    "KB-302",
    "KB-301",
    "KB-401"
  ],
  "customer_reply_draft": "ขอบคุณที่แจ้งครับ จากอาการที่เล่ามา ทั้งคุณและเพื่อนร่วมงานหลายคนเจอ error 500 พร้อมกัน และลองหลายเบราว์เซอร์แล้ว น่าจะเป็นปัญหาฝั่งบริการมากกว่าฝั่งเครื่องของคุณ\n\nขณะนี้ทีมวิศวกรรมของเรากำลังตรวจสอบปัญหาที่อาจกระทบ region Asia ให้แล้ว และได้รับทราบว่าเป็นบัญชี Enterprise ของคุณด้วย รวมถึงมีเวลาเร่งด่วนเพราะคุณมี demo กับลูกค้ารายใหญ่บ่ายนี้ ผมได้ส่งต่อรายละเอียดนี้ให้ทีมแล้วเพื่อเร่งตรวจสอบ\n\nหมายเหตุ: หน้า status.company.com อาจยังแสดงว่า all systems operational ได้ในช่วงที่ปัญหา regional ยังไม่ถูกประกาศบนหน้าสถานะสาธารณะ\n\nหากมีอัปเดต ทีมของเราจะติดต่อกลับโดยตรงครับ",
  "internal_note": "Enterprise customer in Thailand/Asia region reporting HTTP 500 and inability to access Web App. Multiple browsers and multiple coworkers affected, since about 2 hours ago. Public status page says all systems operational, but internal monitoring shows Asia Web App/API degraded with elevated 5xx errors from ap-southeast load balancer since about 2 hours ago; no public incident posted yet. Enterprise SLA notes 1 hour response target for critical issues. Customer says there is a demo with a major client this afternoon and the deal may be lost if service is not restored. Route to Engineering_Incident urgently; no billing issue.",
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
    "product_detail": "Appearance settings and theme scheduling",
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
  "customer_reply_draft": "Hi Taylor, thanks for checking and for the extra details.\n\nYes, on Pro the available theme options are Light and System Default. There is not a separate Dark toggle yet. System Default follows your operating system theme, so if your Mac is set to dark mode, the app should match it.\n\nIf it is still showing light after switching to System Default, please try:\n1. Fully quit and reopen the app after changing your Mac theme.\n2. Make sure you are on the latest app version.\n\nFor reference, the help article is here: https://help.company.com/articles/appearance-settings\n\nOn your separate question about scheduling dark mode, the app does not have its own theme schedule yet. The current workaround is to leave the app on System Default and use your Mac's automatic appearance switching. On macOS, you can enable Auto in System Settings > Appearance to switch between light and dark by time of day.\n\nI've also passed your request for scheduled dark mode to our product team as a feature request.",
  "internal_note": "Customer is a Pro plan, 5-month daily active macOS desktop app user with no prior tickets. They asked about dark mode, then reported that System Default stays light even though macOS is in dark mode, and asked for scheduled dark mode. KB says only Light and System Default are available on all plans; System Default should follow OS theme. Troubleshooting steps: fully quit/reopen app and update app. Separate feature request for scheduled dark mode should go to Product. No billing issue; recent Pro charge TX-8120 captured.",
  "confidence": 0.93,
  "guardrails_applied": []
}
```

import sys
import time

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[38;5;84m"
RED = "\033[38;5;203m"
YELLOW = "\033[38;5;221m"
CYAN = "\033[38;5;117m"
GRAY = "\033[38;5;245m"

def banner():
    print(f"\n{BOLD}{CYAN}🛡️  SentinelMCP — Stateless Policy Firewall & Token-Cost Proxy{RESET}")
    print(f"{GRAY}────────────────────────────────────────────────────────────────────────{RESET}")
    print(f"{DIM}• Mode:       Stateless Edge Proxy (0 DBs, 0 Sticky Sessions){RESET}")
    print(f"{DIM}• Upstream:   mock://internal-postgres-mcp:8080{RESET}")
    print(f"{DIM}• Policy:     ./policies/production-rbac.yaml (Loaded in 0.4ms){RESET}")
    print(f"{DIM}• Budget Cap: $0.050 USD / minute per Agent Identity{RESET}")
    print(f"{GRAY}────────────────────────────────────────────────────────────────────────{RESET}\n")
    time.sleep(1.5)

def scenario_1_allowed():
    print(f"{BOLD}[Scenario 1/3] Legitimate Agent Tool Execution{RESET}")
    time.sleep(0.6)
    print(f"{GRAY}→ Incoming MCP Request:{RESET} {CYAN}tools/call{RESET} {BOLD}get_order_status{RESET} {GRAY}(role=support_agent){RESET}")
    time.sleep(0.5)
    print(f"  ├─ Identity Check: {GREEN}✓ Verified JWT (sub: agent-support-01){RESET}")
    print(f"  ├─ Policy Check:   {GREEN}✓ Rule 'allow_read_orders' matched{RESET}")
    print(f"  ├─ Token Cost:     {GREEN}$0.004 USD{RESET} {GRAY}(Window total: $0.004 / $0.050){RESET}")
    print(f"  └─ Action:         {BOLD}{GREEN}[200 OK — FORWARDED TO MCP SERVER (0.7ms)]{RESET}\n")
    time.sleep(2.0)

def scenario_2_policy_block():
    print(f"{BOLD}[Scenario 2/3] Prompt-Injected Unauthorized Tool Call{RESET}")
    time.sleep(0.6)
    print(f"{GRAY}→ Incoming MCP Request:{RESET} {CYAN}tools/call{RESET} {BOLD}export_all_users_pii{RESET} {GRAY}(role=support_agent){RESET}")
    time.sleep(0.5)
    print(f"  ├─ Identity Check: {GREEN}✓ Verified JWT (sub: agent-support-01){RESET}")
    print(f"  ├─ Policy Check:   {RED}✗ DENIED by rule 'block_pii_export_non_admin'{RESET}")
    print(f"  ├─ Upstream Touch: {CYAN}0 bytes sent to MCP server (Blocked at Edge){RESET}")
    print(f"  └─ Action:         {BOLD}{RED}[403 FORBIDDEN — TOOL CALL BLOCKED (0.3ms)]{RESET}\n")
    time.sleep(2.2)

def scenario_3_token_loop():
    print(f"{BOLD}[Scenario 3/3] Runaway Agent Reasoning Loop (Token Budget Circuit Breaker){RESET}")
    time.sleep(0.6)
    loops = [
        (1, "4,200 tokens", "$0.018", "$0.022", True),
        (2, "4,850 tokens", "$0.021", "$0.043", True),
        (3, "5,100 tokens", "$0.022", "$0.065", False),
    ]
    for attempt, tokens, cost, cumulative, allowed in loops:
        print(f"{GRAY}→ Loop #{attempt}:{RESET} {CYAN}tools/call{RESET} {BOLD}query_vector_kb{RESET} {GRAY}({tokens} | +{cost}){RESET}")
        time.sleep(0.4)
        if allowed:
            print(f"  └─ Budget State:   {YELLOW}{cumulative} / $0.050 cap{RESET} → {GREEN}[200 ALLOWED]{RESET}")
        else:
            print(f"  ├─ Budget State:   {RED}{cumulative} / $0.050 cap (EXCEEDED){RESET}")
            print(f"  ├─ Circuit State:  {RED}⚡ Stateless Window Limit Tripped for 'agent-support-01'{RESET}")
            print(f"  └─ Action:         {BOLD}{RED}[429 BUDGET EXCEEDED — RUNAWAY LOOP HALTED]{RESET}\n")
        time.sleep(0.9)

    print(f"{GRAY}────────────────────────────────────────────────────────────────────────{RESET}")
    print(f"{BOLD}{GREEN}✓ Demo Complete:{RESET} 1 Allowed | 1 Policy Violation Blocked | 1 Runaway Loop Halted\n")

if __name__ == "__main__":
    banner()
    scenario_1_allowed()
    scenario_2_policy_block()
    scenario_3_token_loop()
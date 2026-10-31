# mod-puppy: 세션 강아지 띠 (session-pup)

This is a Claude Code mod. It shows a status band above the prompt with this session's name, its main and current work, the model, the effort, how full the context is, the progress in %, and a running pixel puppy.

Claude Code 입력창 바로 위에 이 세션의 정보와 달리는 강아지를 보여 주는 mod입니다. 세션과 작업공간(worktree)을 여러 개 열어 둘 때 어느 세션이 무슨 일을 하는지 한눈에 볼 수 있습니다.

```
[픽셀 강아지 ──▶ 🏁]  🐾 otter-1a · shop/otter · feature/login · 같은 작업공간: otter-2b(쉼)
                      메인 ▸ 로그인 화면 고치기
                      서브 ▸ 테스트 돌리기 · 고치기 login.tsx
                      진행 40% · Opus 5.5 · Effort high · 컨텍스트 23% (230k/1M)
```

## 보여 주는 것

- **세션:** 이름(이 컴퓨터의 세션 목록에 있는 이름), 폴더와 브랜치, 같은 폴더에서 일하는 다른 세션과 그 상태
- **작업:** 메인(전체 작업)과 서브(지금 하는 단계, 실행 중인 도구와 하위 에이전트)
- **모델 정보:** 모델, Effort, 컨텍스트 사용량
- **진행률(%):** AI가 단계마다 직접 알려 주는 추정치
- **강아지:**
  - 작업 중일 때는 진행률만큼 깃발 쪽으로 달립니다.
  - 쉴 때는 엎드려 잡니다.
  - 100%가 되면 깃발 옆에서 쉽니다.

## 설치

Claude Code 터미널 세션의 입력창에 아래 줄을 입력합니다.

```
/plugin install session-pup --marketplace Davechankim/mod-puppy
```

`Add marketplace?`가 뜨면 `y`를 누르고, 범위는 맨 위의 user를 고릅니다.

셸에서 설치할 때는 아래 줄을 씁니다.

```
claude plugin install session-pup --marketplace Davechankim/mod-puppy
```

데스크톱 앱에서는 입력창 옆 + → Plugins → Add marketplace에 `Davechankim/mod-puppy`를 넣고 Add plugin을 누릅니다.

## 알아 둘 것

- **진행률 도구:** 진행률을 받으려고 `mcp__session-pup__progress` 도구 하나와 시스템 프롬프트 안내 한 단락을 더합니다.
  - 이 도구는 메인 대화만 부릅니다.
  - 하위 에이전트와 화면 없는 실행(`claude -p`)에는 안내하지 않습니다.
- **읽는 파일:** 아래 둘만 읽고, 밖으로 보내는 것은 없습니다.
  - `~/.claude/sessions/*.json`: 세션 이름과 상태를 읽습니다. 바로 옆의 `.key` 파일은 읽지 않습니다.
  - 작업 폴더의 `.git` 안 `HEAD`: 브랜치를 읽습니다.
- **접기·끄기·지우기:**
  - 띠 오른쪽의 `[-]`로 접을 수 있습니다.
  - 끄기: `claude plugin disable session-pup@mod-puppy`
  - 지우기: `claude plugin uninstall session-pup@mod-puppy`
- **화면별 차이:** 강아지 그림은 터미널에서만 나옵니다. 데스크톱 앱 등에서는 한 줄 막대(🐶 ████░░ 40%)로 보입니다.
- **필요한 버전:** Claude Code의 mod(function hooks) 기능이 있는 버전이 필요합니다. 이 mod는 2.1.307에서 만들었고, 이 기능은 아직 early access입니다.

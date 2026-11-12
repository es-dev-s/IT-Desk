# IT-Desk monorepo tasks. Go caches stay inside the repo (.cache/, gitignored).
SHELL := /bin/bash
ROOT  := $(abspath .)
# GO: the go on PATH, else the snap's binary called directly (snap-confine can
# refuse "snap run" in some sessions), else a project-local toolchain in .cache/go.
GO ?= $(shell if go version >/dev/null 2>&1; then echo go; elif [ -x /snap/go/current/bin/go ]; then echo /snap/go/current/bin/go; elif [ -x $(CURDIR)/.cache/go/bin/go ]; then echo $(CURDIR)/.cache/go/bin/go; else echo go; fi)
GOENV := GOMODCACHE=$(ROOT)/.cache/gomod GOCACHE=$(ROOT)/.cache/gobuild GOFLAGS=-modcacherw

.PHONY: help install dev run api web seed seed-reset seed-admin db-clean migrate test test-go test-web lint build stop

help:
	@echo "make install     - go mod download + npm install"
	@echo "make migrate     - apply DB migrations (schema itdesk)"
	@echo "make seed        - seed demo data (no-op if already seeded)"
	@echo "make db-clean    - delete all workspace data + non-admin accounts; keep teams and admins"
	@echo "make seed-reset  - drop schema itdesk and reseed (new demo passwords)"
	@echo "make seed-admin EMAIL=you@company.com NAME='Your Name' - create an admin account"
	@echo "                   (demo passwords go ONLY to backend/.seed-credentials.txt, gitignored)"
	@echo "make dev         - run API (localhost:8080) and web (0.0.0.0:3000, LAN-reachable) together"
	@echo "make run         - start both in the background (logs in .run/); prints the LAN URL"
	@echo "make stop        - stop background processes started by 'make run'"
	@echo "make test        - Go vet+tests and frontend lint+typecheck"

install:
	cd backend && $(GOENV) $(GO) mod download
	cd Frontend && npm install

migrate:
	cd backend && $(GOENV) $(GO) run ./cmd/migrate

seed:
	cd backend && $(GOENV) $(GO) run ./cmd/seed

seed-reset:
	cd backend && $(GOENV) $(GO) run ./cmd/seed --reset

db-clean:
	cd backend && $(GOENV) $(GO) run ./cmd/seed --clean --yes

seed-admin:
	@[ -n "$(EMAIL)" ] || { echo "usage: make seed-admin EMAIL=you@company.com NAME='Your Name'"; exit 1; }
	cd backend && $(GOENV) $(GO) run ./cmd/seed --create-admin --email "$(EMAIL)" --name "$(NAME)"

api:
	cd backend && $(GOENV) $(GO) run ./cmd/api

web:
	cd Frontend && npm run dev

dev:
	@trap 'kill 0' INT TERM EXIT; \
	 (cd backend && HTTP_ADDR=$(API_ADDR) WEB_PORT=$(WEB_PORT) $(GOENV) $(GO) run ./cmd/api) & \
	 (cd Frontend && HOST=$(HOST) PORT=$(WEB_PORT) API_INTERNAL_URL=http://$(API_ADDR) npm run dev) & \
	 wait

# The API listens on localhost only; the web server (Frontend/server.mjs)
# listens on all interfaces and proxies /api to it, so the LAN only ever
# needs port 3000. Set HOST=127.0.0.1 to keep everything local.
HOST     ?= 0.0.0.0
WEB_PORT ?= 3000
API_ADDR ?= 127.0.0.1:8080
LAN_IPS   = $(shell cd Frontend && node -e 'const os=require("os");console.log(Object.entries(os.networkInterfaces()).filter(([n])=>!/^(lo|docker|br-|virbr|veth|vmnet|vboxnet|cni|flannel|cali|podman|kube)/.test(n)).flatMap(([,a])=>a||[]).filter(a=>a.family==="IPv4"&&!a.internal).map(a=>a.address).join(" "))' 2>/dev/null)

run:
	@mkdir -p .run bin
	cd backend && $(GOENV) $(GO) build -o ../bin/itdesk-api ./cmd/api
	@cd backend && { HTTP_ADDR=$(API_ADDR) WEB_PORT=$(WEB_PORT) nohup ../bin/itdesk-api > ../.run/api.log 2>&1 < /dev/null & echo $$! > ../.run/api.pid; }
	@cd Frontend && { HOST=$(HOST) PORT=$(WEB_PORT) API_INTERNAL_URL=http://$(API_ADDR) nohup npm run dev > ../.run/web.log 2>&1 < /dev/null & echo $$! > ../.run/web.pid; }
	@echo "API  -> http://$(API_ADDR)  (localhost only; log .run/api.log)"
	@echo "Web  -> http://localhost:$(WEB_PORT)  (log .run/web.log)"
	@if [ "$(HOST)" = "0.0.0.0" ]; then for ip in $(LAN_IPS); do echo "LAN  -> http://$$ip:$(WEB_PORT)  (open this from another PC)"; done; fi

stop:
	-@[ -f .run/api.pid ] && kill $$(cat .run/api.pid) 2>/dev/null; rm -f .run/api.pid
	-@[ -f .run/web.pid ] && { tree() { for c in $$(pgrep -P $$1); do tree $$c; done; echo $$1; }; kill $$(tree $$(cat .run/web.pid)) 2>/dev/null; }; rm -f .run/web.pid

test: test-go test-web

test-go:
	cd backend && $(GOENV) $(GO) vet ./... && $(GOENV) $(GO) test -count=1 ./...

test-web:
	cd Frontend && npm run lint && npx tsc --noEmit

build:
	cd backend && $(GOENV) $(GO) build -o ../bin/itdesk-api ./cmd/api
	cd Frontend && npm run build

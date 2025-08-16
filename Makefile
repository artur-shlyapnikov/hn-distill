SHELL := /bin/bash
.ONESHELL:
.SHELLFLAGS := -eo pipefail -c

ifneq (,$(wildcard .env))
include .env
endif

.PHONY: all
all: build

BUN := $(shell command -v bun 2>/dev/null)
ifeq ($(BUN),)
$(error "bun is required but not found. Install from https://bun.sh")
endif

.PHONY: install
install:
	bun install --frozen-lockfile || bun install

.PHONY: run
run:
	bun run tsx scripts/fetch-hn.mts
	bun run tsx scripts/summarize.mts
	bun run tsx scripts/aggregate.mts

.PHONY: build
build:
	# Copy search data to public directory for static serving
	mkdir -p public/data
	cp data/search.json public/data/search.json 2>/dev/null || true
	bunx astro build

.PHONY: dev
dev:
	bunx astro dev

.PHONY: preview
preview:
	bunx astro preview

.PHONY: typecheck
typecheck:
	bunx tsc --noEmit --skipLibCheck
	bunx astro check

.PHONY: lint
lint:
	bunx eslint .

.PHONY: test
test:
	bun test

.PHONY: local-test
local-test:
	# Clean previous generated data to force re-download and regeneration
	rm -rf data && mkdir -p data
	# Optionally ensure dist is clean for a fresh site build
	rm -rf dist .astro
	# Generate fresh data with smaller scope for local runs
	TOP_N=5 MAX_COMMENTS_PER_STORY=20 MAX_DEPTH=2 CONCURRENCY=6 \
		bun run tsx scripts/fetch-hn.mts
	TOP_N=5 MAX_COMMENTS_PER_STORY=20 MAX_DEPTH=2 CONCURRENCY=6 \
		bun run tsx scripts/summarize.mts
	TOP_N=5 MAX_COMMENTS_PER_STORY=20 MAX_DEPTH=2 CONCURRENCY=6 \
		bun run tsx scripts/aggregate.mts
	# Copy search data to public directory for static serving
	mkdir -p public/data
	cp data/search.json public/data/search.json 2>/dev/null || true
	# Build the site
	bunx astro build

.PHONY: cleanup
cleanup:
	bun run tsx scripts/cleanup.mts
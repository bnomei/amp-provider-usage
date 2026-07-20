# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-20

### Changed
- Providers without a local credential file are now omitted from usage results. When none of the
  selected providers are configured, the plugin reports that no configured providers are
  available.

### Fixed
- Invalid or unreadable credential files remain visible as provider errors instead of being
  mistaken for unconfigured providers.

## [0.1.0] - 2026-07-20
- Initial Release

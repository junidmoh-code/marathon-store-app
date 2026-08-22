import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const CENSUS_SRC = await import("./enginePolicyPerSize.test.jsx").catch(() => null);

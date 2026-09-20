#!/usr/bin/env python3
"""Tests for the HYDRA Router hook."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Add hooks directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'hooks'))
from importlib import import_module

# Import the module
spec = __import__('importlib').util.spec_from_file_location(
    'hydra_router',
    os.path.join(os.path.dirname(__file__), '..', 'hooks', 'hydra-router.py')
)
hydra_router = __import__('importlib').util.module_from_spec(spec)
spec.loader.exec_module(hydra_router)


class TestClassifyTask(unittest.TestCase):
    """Tests for task classification."""

    def test_code_tasks(self):
        self.assertEqual(hydra_router.classify_task('Write a function to sort'), 'code')
        self.assertEqual(hydra_router.classify_task('Debug this error'), 'code')
        self.assertEqual(hydra_router.classify_task('Implement the API endpoint'), 'code')

    def test_creative_tasks(self):
        self.assertEqual(hydra_router.classify_task('Write a story about space'), 'creative')
        self.assertEqual(hydra_router.classify_task('Compose a poem'), 'creative')

    def test_analysis_tasks(self):
        self.assertEqual(hydra_router.classify_task('Analyze the data'), 'analysis')
        self.assertEqual(hydra_router.classify_task('Compare these approaches'), 'analysis')
        self.assertEqual(hydra_router.classify_task('Summarize this document'), 'analysis')

    def test_math_tasks(self):
        self.assertEqual(hydra_router.classify_task('Calculate the integral'), 'math')
        self.assertEqual(hydra_router.classify_task('Solve the equation'), 'math')

    def test_translation_tasks(self):
        self.assertEqual(hydra_router.classify_task('Translate to French'), 'translation')

    def test_general_fallback(self):
        self.assertEqual(hydra_router.classify_task('Hello, how are you?'), 'general')
        self.assertEqual(hydra_router.classify_task(''), 'general')

    def test_none_input(self):
        self.assertEqual(hydra_router.classify_task(None), 'general')


class TestGetOptimalModel(unittest.TestCase):
    """Tests for model routing."""

    def test_returns_routing_dict(self):
        result = hydra_router.get_optimal_model('code')
        self.assertIn('recommended_model', result)
        self.assertIn('fallback_models', result)
        self.assertIn('source', result)
        self.assertIn('task_type', result)

    def test_code_routing(self):
        result = hydra_router.get_optimal_model('code')
        self.assertEqual(result['task_type'], 'code')
        self.assertIn(result['recommended_model'], hydra_router.DEFAULT_ROUTES['code'])

    def test_creative_routing(self):
        result = hydra_router.get_optimal_model('creative')
        self.assertEqual(result['task_type'], 'creative')

    def test_general_routing(self):
        result = hydra_router.get_optimal_model('general')
        self.assertEqual(result['task_type'], 'general')

    def test_unknown_task_uses_general(self):
        result = hydra_router.get_optimal_model('nonexistent')
        self.assertEqual(result['fallback_models'], hydra_router.DEFAULT_ROUTES['general'])

class TestExtractPrompt(unittest.TestCase):
    """Tests for prompt extraction from hook input."""

    def test_extracts_prompt_field(self):
        hook_input = {'tool_input': {'prompt': 'Hello world'}}
        self.assertEqual(hydra_router.extract_prompt_from_hook_input(hook_input), 'Hello world')

    def test_extracts_message_field(self):
        hook_input = {'tool_input': {'message': 'Test message'}}
        self.assertEqual(hydra_router.extract_prompt_from_hook_input(hook_input), 'Test message')

    def test_extracts_bash_command(self):
        hook_input = {'tool_name': 'Bash', 'tool_input': {'command': 'npm test'}}
        self.assertEqual(hydra_router.extract_prompt_from_hook_input(hook_input), 'npm test')

    def test_extracts_from_messages_array(self):
        hook_input = {'tool_input': {'messages': [{'role': 'user', 'content': 'From messages'}]}}
        self.assertEqual(hydra_router.extract_prompt_from_hook_input(hook_input), 'From messages')

    def test_returns_empty_for_no_prompt(self):
        hook_input = {'tool_input': {'foo': 'bar'}}
        self.assertEqual(hydra_router.extract_prompt_from_hook_input(hook_input), '')

    def test_handles_missing_tool_input(self):
        self.assertEqual(hydra_router.extract_prompt_from_hook_input({}), '')


class TestLoadLearnedPreferences(unittest.TestCase):
    """Tests for loading learned preferences."""

    def test_returns_empty_dict_if_no_store(self):
        original = hydra_router.STORE_PATH
        hydra_router.STORE_PATH = Path('/tmp/nonexistent-hydra-store.json')
        result = hydra_router.load_learned_preferences()
        hydra_router.STORE_PATH = original
        self.assertEqual(result, {})

    def test_loads_from_valid_store(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump({'preferences': {'code': {'recommended': 'test-model'}}}, f)
            f.flush()
            original = hydra_router.STORE_PATH
            hydra_router.STORE_PATH = Path(f.name)
            result = hydra_router.load_learned_preferences()
            hydra_router.STORE_PATH = original
            os.unlink(f.name)
        self.assertEqual(result['code']['recommended'], 'test-model')

    def test_handles_invalid_json(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            f.write('not valid json{{{')
            f.flush()
            original = hydra_router.STORE_PATH
            hydra_router.STORE_PATH = Path(f.name)
            result = hydra_router.load_learned_preferences()
            hydra_router.STORE_PATH = original
            os.unlink(f.name)
        self.assertEqual(result, {})


class TestDefaultRoutes(unittest.TestCase):
    """Tests for default routing configuration."""

    def test_all_task_types_have_routes(self):
        for task_type in ['code', 'creative', 'analysis', 'math', 'translation', 'general']:
            self.assertIn(task_type, hydra_router.DEFAULT_ROUTES)
            self.assertTrue(len(hydra_router.DEFAULT_ROUTES[task_type]) > 0)

if __name__ == '__main__':
    unittest.main()

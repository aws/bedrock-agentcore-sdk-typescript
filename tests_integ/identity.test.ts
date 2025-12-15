/**
 * Integration tests for AgentCore Identity SDK
 * 
 * These tests require:
 * - AWS credentials configured
 * - AgentCore Identity service available in the region
 * - Permissions to create/delete identities and providers
 * 
 * For OAuth2 token tests:
 * - Set OAUTH2_PROVIDER_NAME env var to test OAuth2 M2M flow
 * - Set OAUTH2_SCOPES env var (comma-separated)
 * 
 * For API key tests:
 * - Set APIKEY_PROVIDER_NAME env var to test API key retrieval
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IdentityClient, withAccessToken, withApiKey } from '../src/identity';
import { AgentCoreContext } from '../src/runtime/context';

describe('Identity Integration Tests', () => {
  const testIdentityName = `test-identity-${Date.now()}`;
  const testOAuth2ProviderName = `test-oauth2-${Date.now()}`;
  const testApiKeyProviderName = `test-apikey-${Date.now()}`;
  let client: IdentityClient;
  let workloadToken: string | undefined;

  beforeAll(async () => {
    client = new IdentityClient();
    
    // Create a test workload identity and get workload token
    try {
      await client.createWorkloadIdentity(testIdentityName);
      // Get workload access token for testing
      workloadToken = await client.getWorkloadAccessTokenForUserId(testIdentityName, 'test-user-123');
      console.log('Workload token obtained for testing');
    } catch (e) {
      console.warn('Could not create test workload identity or get token:', e);
    }
  });

  afterAll(async () => {
    // Cleanup - delete test resources
    try {
      await client.deleteOAuth2CredentialProvider(testOAuth2ProviderName);
    } catch (e) {
      // Ignore if doesn't exist
    }
    try {
      await client.deleteApiKeyCredentialProvider(testApiKeyProviderName);
    } catch (e) {
      // Ignore if doesn't exist
    }
    try {
      await client.deleteWorkloadIdentity(testIdentityName);
    } catch (e) {
      // Ignore if doesn't exist
    }
  });

  describe('Workload Identity Lifecycle', () => {
    it('should create, get, and delete workload identity', async () => {
      // Delete first in case it exists from previous run
      try {
        await client.deleteWorkloadIdentity(testIdentityName);
      } catch (e) {
        // Ignore if doesn't exist
      }

      // Create
      const created = await client.createWorkloadIdentity(testIdentityName, [
        'https://example.com/callback',
      ]);
      expect(created.name).toBe(testIdentityName);
      expect(created.workloadIdentityArn).toBeDefined();
      expect(created.allowedResourceOauth2ReturnUrls).toContain('https://example.com/callback');

      // Get
      const retrieved = await client.getWorkloadIdentity(testIdentityName);
      expect(retrieved.name).toBe(testIdentityName);
      expect(retrieved.workloadIdentityArn).toBe(created.workloadIdentityArn);

      // Delete
      await client.deleteWorkloadIdentity(testIdentityName);

      // Verify deleted
      await expect(client.getWorkloadIdentity(testIdentityName)).rejects.toThrow();
    });
  });

  describe('OAuth2 Provider Lifecycle', () => {
    it('should create, get, and delete OAuth2 provider', async () => {
      // Create
      const created = await client.createOAuth2CredentialProvider({
        name: testOAuth2ProviderName,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
      });
      expect(created.name).toBe(testOAuth2ProviderName);
      expect(created.credentialProviderArn).toBeDefined();
      expect(created.callbackUrl).toBeDefined();

      // Get
      const retrieved = await client.getOAuth2CredentialProvider(testOAuth2ProviderName);
      expect(retrieved.name).toBe(testOAuth2ProviderName);
      expect(retrieved.credentialProviderArn).toBe(created.credentialProviderArn);

      // Delete
      await client.deleteOAuth2CredentialProvider(testOAuth2ProviderName);

      // Verify deleted
      await expect(client.getOAuth2CredentialProvider(testOAuth2ProviderName)).rejects.toThrow();
    });
  });

  describe('API Key Provider Lifecycle', () => {
    it('should create, get, and delete API key provider', async () => {
      // Create
      const created = await client.createApiKeyCredentialProvider({
        name: testApiKeyProviderName,
        apiKey: 'sk-test-key-123456789',
      });
      expect(created.name).toBe(testApiKeyProviderName);
      expect(created.credentialProviderArn).toBeDefined();

      // Get
      const retrieved = await client.getApiKeyCredentialProvider(testApiKeyProviderName);
      expect(retrieved.name).toBe(testApiKeyProviderName);
      expect(retrieved.credentialProviderArn).toBe(created.credentialProviderArn);

      // Delete
      await client.deleteApiKeyCredentialProvider(testApiKeyProviderName);

      // Verify deleted
      await expect(client.getApiKeyCredentialProvider(testApiKeyProviderName)).rejects.toThrow();
    });
  });

  describe('Context Integration', () => {
    it('should store and retrieve workload token from context', () => {
      const token = 'test-workload-token-123';
      AgentCoreContext.setWorkloadAccessToken(token);
      expect(AgentCoreContext.getWorkloadAccessToken()).toBe(token);
    });

    it('should store and retrieve request headers from context', () => {
      const headers = {
        Authorization: 'Bearer jwt-token-123',
        'Content-Type': 'application/json',
      };
      AgentCoreContext.setRequestHeaders(headers);
      expect(AgentCoreContext.getRequestHeaders()).toEqual(headers);
    });
  });

  describe('HOF Wrappers', () => {
    it('should wrap function with withAccessToken', async () => {
      // Note: This test verifies the wrapper works, but won't actually fetch a token
      // without a real workload token and provider setup
      const wrappedFn = withAccessToken({
        providerName: 'test-provider',
        scopes: ['read'],
        authFlow: 'M2M',
      })(async (input: string, token: string) => {
        return { input, tokenLength: token.length };
      });

      expect(wrappedFn).toBeDefined();
      expect(typeof wrappedFn).toBe('function');
    });

    it('should wrap function with withApiKey', async () => {
      const wrappedFn = withApiKey({
        providerName: 'test-provider',
      })(async (input: string, apiKey: string) => {
        return { input, keyLength: apiKey.length };
      });

      expect(wrappedFn).toBeDefined();
      expect(typeof wrappedFn).toBe('function');
    });
  });

  describe('OAuth2 Token Retrieval (Requires Setup)', () => {
    it.skipIf(!process.env.OAUTH2_PROVIDER_NAME)('should retrieve OAuth2 token for M2M flow', async () => {
      const providerName = process.env.OAUTH2_PROVIDER_NAME!;
      const scopes = process.env.OAUTH2_SCOPES?.split(',') || ['openid'];
      
      if (!workloadToken) {
        console.warn('Skipping: No workload token available');
        return;
      }

      const token = await client.getOAuth2Token({
        providerName,
        scopes,
        authFlow: 'M2M',
        workloadIdentityToken: workloadToken,
      });

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it.skipIf(!process.env.OAUTH2_PROVIDER_NAME)('should handle USER_FEDERATION flow with auth URL', async () => {
      const providerName = process.env.OAUTH2_PROVIDER_NAME!;
      const scopes = process.env.OAUTH2_SCOPES?.split(',') || ['openid'];
      
      if (!workloadToken) {
        console.warn('Skipping: No workload token available');
        return;
      }

      let authUrl: string | undefined;
      
      // This will return an auth URL and start polling
      // In a real scenario, user would visit the URL
      const tokenPromise = client.getOAuth2Token({
        providerName,
        scopes,
        authFlow: 'USER_FEDERATION',
        workloadIdentityToken: workloadToken,
        callbackUrl: 'https://example.com/callback',
        onAuthUrl: (url) => {
          authUrl = url;
          console.log('Authorization URL:', url);
        },
      });

      // Wait a bit for auth URL callback
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(authUrl).toBeDefined();
      expect(authUrl).toContain('http');
      
      // Note: Token promise will timeout unless user completes auth
      // This test just verifies the auth URL is returned
    });
  });

  describe('API Key Retrieval (Requires Setup)', () => {
    it.skipIf(!process.env.APIKEY_PROVIDER_NAME)('should retrieve API key', async () => {
      const providerName = process.env.APIKEY_PROVIDER_NAME!;
      
      if (!workloadToken) {
        console.warn('Skipping: No workload token available');
        return;
      }

      const apiKey = await client.getApiKey({
        providerName,
        workloadIdentityToken: workloadToken,
      });

      expect(apiKey).toBeDefined();
      expect(typeof apiKey).toBe('string');
      expect(apiKey.length).toBeGreaterThan(0);
    });
  });

  describe('Error Scenarios', () => {
    it('should throw error when getting non-existent workload identity', async () => {
      await expect(
        client.getWorkloadIdentity('non-existent-identity-12345')
      ).rejects.toThrow();
    });

    it('should throw error when getting non-existent OAuth2 provider', async () => {
      await expect(
        client.getOAuth2CredentialProvider('non-existent-provider-12345')
      ).rejects.toThrow();
    });

    it('should throw error when getting non-existent API key provider', async () => {
      await expect(
        client.getApiKeyCredentialProvider('non-existent-provider-12345')
      ).rejects.toThrow();
    });

    it('should throw error when deleting non-existent workload identity', async () => {
      await expect(
        client.deleteWorkloadIdentity('non-existent-identity-12345')
      ).rejects.toThrow();
    });

    it('should throw error for OAuth2 token without workload token', async () => {
      await expect(
        client.getOAuth2Token({
          providerName: 'any-provider',
          scopes: ['read'],
          authFlow: 'M2M',
          workloadIdentityToken: 'invalid-token-12345',
        })
      ).rejects.toThrow();
    });

    it('should throw error for API key without workload token', async () => {
      await expect(
        client.getApiKey({
          providerName: 'any-provider',
          workloadIdentityToken: 'invalid-token-12345',
        })
      ).rejects.toThrow();
    });
  });
});

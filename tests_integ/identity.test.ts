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
import { IdentityClient, withAccessToken, withApiKey } from '../src/identity/index.js';

describe('Identity Integration Tests', () => {
  const testIdentityName = `test-identity-${Date.now()}`;
  const testOAuth2ProviderName = `test-oauth2-${Date.now()}`;
  const testApiKeyProviderName = `test-apikey-${Date.now()}`;
  let client: IdentityClient;

  beforeAll(async () => {
    client = new IdentityClient(process.env.AWS_REGION || 'us-west-2');
  });

  afterAll(async () => {
    // Cleanup test-specific resources
    await Promise.allSettled([
      client.deleteOAuth2CredentialProvider(testOAuth2ProviderName),
      client.deleteApiKeyCredentialProvider(testApiKeyProviderName),
      client.deleteWorkloadIdentity(testIdentityName),
    ]);
  });

  describe('Workload Identity Lifecycle', () => {
    it('creates, gets, and deletes workload identity', async () => {
      try {
        await client.deleteWorkloadIdentity(testIdentityName);
      } catch {}

      const created = await client.createWorkloadIdentity(testIdentityName, [
        'https://example.com/callback',
      ]);
      
      expect(created).toEqual({
        name: testIdentityName,
        workloadIdentityArn: expect.any(String),
        allowedResourceOauth2ReturnUrls: ['https://example.com/callback'],
      });

      const retrieved = await client.getWorkloadIdentity(testIdentityName);
      expect(retrieved).toEqual({
        name: testIdentityName,
        workloadIdentityArn: created.workloadIdentityArn,
        allowedResourceOauth2ReturnUrls: ['https://example.com/callback'],
      });

      await client.deleteWorkloadIdentity(testIdentityName);
      await expect(client.getWorkloadIdentity(testIdentityName)).rejects.toThrow();
    }, 30000);
  });

  describe('OAuth2 Provider Lifecycle', () => {
    it('creates, gets, and deletes OAuth2 provider', async () => {
      const created = await client.createOAuth2CredentialProvider({
        name: testOAuth2ProviderName,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
      });
      
      expect(created).toEqual({
        name: testOAuth2ProviderName,
        credentialProviderArn: expect.any(String),
        callbackUrl: expect.any(String),
      });

      const retrieved = await client.getOAuth2CredentialProvider(testOAuth2ProviderName);
      expect(retrieved).toEqual({
        name: testOAuth2ProviderName,
        credentialProviderArn: created.credentialProviderArn,
        callbackUrl: expect.any(String),
      });

      await client.deleteOAuth2CredentialProvider(testOAuth2ProviderName);
      await expect(client.getOAuth2CredentialProvider(testOAuth2ProviderName)).rejects.toThrow();
    }, 30000);
  });

  describe('API Key Provider Lifecycle', () => {
    it('creates, gets, and deletes API key provider', async () => {
      const created = await client.createApiKeyCredentialProvider({
        name: testApiKeyProviderName,
        apiKey: 'sk-test-key-123456789',
      });
      
      expect(created).toEqual({
        name: testApiKeyProviderName,
        credentialProviderArn: expect.any(String),
      });

      const retrieved = await client.getApiKeyCredentialProvider(testApiKeyProviderName);
      expect(retrieved).toEqual({
        name: testApiKeyProviderName,
        credentialProviderArn: created.credentialProviderArn,
      });

      await client.deleteApiKeyCredentialProvider(testApiKeyProviderName);
      await expect(client.getApiKeyCredentialProvider(testApiKeyProviderName)).rejects.toThrow();
    }, 30000);
  });

  describe('HOF Wrappers', () => {
    it('wraps function with withAccessToken', async () => {
      // Set region for wrapper's internal IdentityClient
      process.env.AWS_REGION = process.env.AWS_REGION || 'us-west-2';
      
      const wrappedFn = withAccessToken<[string], { input: string; tokenLength: number }>({
        workloadIdentityToken: 'test-workload-token',
        providerName: 'test-provider',
        scopes: ['read'],
        authFlow: 'M2M',
      })(async (input: string, token: string) => {
        return { input, tokenLength: token.length };
      });

      expect(wrappedFn).toBeDefined();
      expect(typeof wrappedFn).toBe('function');
    });

    it('wraps function with withApiKey', async () => {
      // Set region for wrapper's internal IdentityClient
      process.env.AWS_REGION = process.env.AWS_REGION || 'us-west-2';
      
      const wrappedFn = withApiKey<[string], { input: string; keyLength: number }>({
        workloadIdentityToken: 'test-workload-token',
        providerName: 'test-provider',
      })(async (input: string, apiKey: string) => {
        return { input, keyLength: apiKey.length };
      });

      expect(wrappedFn).toBeDefined();
      expect(typeof wrappedFn).toBe('function');
    });
  });

  describe('M2M OAuth2 Token Retrieval (Full Flow)', { timeout: 60000 }, () => {
    it('completes full M2M flow with Cognito', async () => {
      // This test requires AWS Cognito permissions
      const { 
        CognitoIdentityProviderClient, 
        ListUserPoolsCommand,
        CreateUserPoolCommand, 
        CreateResourceServerCommand, 
        CreateUserPoolClientCommand, 
        CreateUserPoolDomainCommand,
        DescribeUserPoolClientCommand,
        ListUserPoolClientsCommand,
      } = await import('@aws-sdk/client-cognito-identity-provider');
      
      const region = process.env.AWS_REGION || 'us-west-2';
      const cognito = new CognitoIdentityProviderClient({ region });
      const poolName = 'AgentCoreSDKIntegTest';
      const domainPrefix = 'agentcore-sdk-integ';
      
      // Check if pool already exists
      const listResponse = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60 }));
      let existingPool = listResponse.UserPools?.find(p => p.Name === poolName);
      
      let userPoolId: string;
      let clientId: string;
      let clientSecret: string;

      if (existingPool) {
        // Reuse existing pool
        userPoolId = existingPool.Id!;
        
        const clientsResponse = await cognito.send(new ListUserPoolClientsCommand({ 
          UserPoolId: userPoolId,
          MaxResults: 10,
        }));
        const existingClient = clientsResponse.UserPoolClients?.[0];
        
        if (existingClient) {
          const clientDetails = await cognito.send(new DescribeUserPoolClientCommand({
            UserPoolId: userPoolId,
            ClientId: existingClient.ClientId!,
          }));
          clientId = existingClient.ClientId!;
          clientSecret = clientDetails.UserPoolClient!.ClientSecret!;
        } else {
          // Create new client for existing pool
          const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
            UserPoolId: userPoolId,
            ClientName: 'M2MTestClient',
            GenerateSecret: true,
            AllowedOAuthFlows: ['client_credentials'],
            AllowedOAuthScopes: ['test-api/read'],
            AllowedOAuthFlowsUserPoolClient: true,
          }));
          clientId = clientResponse.UserPoolClient!.ClientId!;
          clientSecret = clientResponse.UserPoolClient!.ClientSecret!;
        }
      } else {
        // Create new pool
        const poolResponse = await cognito.send(new CreateUserPoolCommand({
          PoolName: poolName,
        }));
        userPoolId = poolResponse.UserPool!.Id!;

        await cognito.send(new CreateUserPoolDomainCommand({
          Domain: domainPrefix,
          UserPoolId: userPoolId,
        }));

        // Wait for domain to become active
        await new Promise(resolve => setTimeout(resolve, 5000));

        await cognito.send(new CreateResourceServerCommand({
          UserPoolId: userPoolId,
          Identifier: 'test-api',
          Name: 'Test API',
          Scopes: [{ ScopeName: 'read', ScopeDescription: 'Read access' }],
        }));

        const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
          UserPoolId: userPoolId,
          ClientName: 'M2MTestClient',
          GenerateSecret: true,
          AllowedOAuthFlows: ['client_credentials'],
          AllowedOAuthScopes: ['test-api/read'],
          AllowedOAuthFlowsUserPoolClient: true,
        }));
        clientId = clientResponse.UserPoolClient!.ClientId!;
        clientSecret = clientResponse.UserPoolClient!.ClientSecret!;
      }

      // Create AgentCore Identity OAuth2 provider
      const discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
      const providerName = `test-m2m-provider-${Date.now()}`;
      const workloadName = `test-m2m-workload-${Date.now()}`;
      
      try {
        await client.createOAuth2CredentialProvider({
          name: providerName,
          clientId,
          clientSecret,
          discoveryUrl,
        });

        await client.createWorkloadIdentity(workloadName);
        const workloadToken = await client.getWorkloadAccessTokenForUserId(workloadName, 'test-user');

        const token = await client.getOAuth2Token({
          providerName,
          scopes: ['test-api/read'],
          authFlow: 'M2M',
          workloadIdentityToken: workloadToken,
        });

        expect(token).toBeDefined();
        expect(typeof token).toBe('string');
        expect(token.length).toBeGreaterThan(0);
      } finally {
        // Cleanup AgentCore resources only (not Cognito pool)
        try { await client.deleteOAuth2CredentialProvider(providerName); } catch {}
        try { await client.deleteWorkloadIdentity(workloadName); } catch {}
      }
    });
  });

  describe('Error Scenarios', () => {
    it('throws error when getting non-existent workload identity', async () => {
      await expect(
        client.getWorkloadIdentity('non-existent-identity-12345')
      ).rejects.toThrow();
    });

    it('throws error when getting non-existent OAuth2 provider', async () => {
      await expect(
        client.getOAuth2CredentialProvider('non-existent-provider-12345')
      ).rejects.toThrow();
    });

    it('throws error when getting non-existent API key provider', async () => {
      await expect(
        client.getApiKeyCredentialProvider('non-existent-provider-12345')
      ).rejects.toThrow();
    });

    it('throws error when deleting non-existent workload identity', async () => {
      await expect(
        client.deleteWorkloadIdentity('non-existent-identity-12345')
      ).rejects.toThrow();
    });

    it('throws error for OAuth2 token without workload token', async () => {
      await expect(
        client.getOAuth2Token({
          providerName: 'any-provider',
          scopes: ['read'],
          authFlow: 'M2M',
          workloadIdentityToken: 'invalid-token-12345',
        })
      ).rejects.toThrow();
    });

    it('throws error for API key without workload token', async () => {
      await expect(
        client.getApiKey({
          providerName: 'any-provider',
          workloadIdentityToken: 'invalid-token-12345',
        })
      ).rejects.toThrow();
    });
  });

  describe('Concurrent Request Tests', { timeout: 90000 }, () => {
    it('handles concurrent OAuth2 token requests', async () => {
      const { 
        CognitoIdentityProviderClient, 
        ListUserPoolsCommand,
        CreateUserPoolCommand, 
        CreateResourceServerCommand, 
        CreateUserPoolClientCommand, 
        CreateUserPoolDomainCommand,
        DescribeUserPoolClientCommand,
        ListUserPoolClientsCommand,
      } = await import('@aws-sdk/client-cognito-identity-provider');
      
      const region = process.env.AWS_REGION || 'us-west-2';
      const cognito = new CognitoIdentityProviderClient({ region });
      const poolName = 'AgentCoreSDKIntegTest';
      const domainPrefix = 'agentcore-sdk-integ';
      
      // Check if pool already exists
      const listResponse = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60 }));
      let existingPool = listResponse.UserPools?.find(p => p.Name === poolName);
      
      let userPoolId: string;
      let clientId: string;
      let clientSecret: string;

      if (existingPool) {
        // Reuse existing pool
        userPoolId = existingPool.Id!;
        
        const clientsResponse = await cognito.send(new ListUserPoolClientsCommand({ 
          UserPoolId: userPoolId,
          MaxResults: 10,
        }));
        const existingClient = clientsResponse.UserPoolClients?.[0];
        
        if (existingClient) {
          const clientDetails = await cognito.send(new DescribeUserPoolClientCommand({
            UserPoolId: userPoolId,
            ClientId: existingClient.ClientId!,
          }));
          clientId = existingClient.ClientId!;
          clientSecret = clientDetails.UserPoolClient!.ClientSecret!;
        } else {
          const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
            UserPoolId: userPoolId,
            ClientName: 'ConcurrentTestClient',
            GenerateSecret: true,
            AllowedOAuthFlows: ['client_credentials'],
            AllowedOAuthScopes: ['test-api/read'],
            AllowedOAuthFlowsUserPoolClient: true,
          }));
          clientId = clientResponse.UserPoolClient!.ClientId!;
          clientSecret = clientResponse.UserPoolClient!.ClientSecret!;
        }
      } else {
        // Create new pool
        const poolResponse = await cognito.send(new CreateUserPoolCommand({
          PoolName: poolName,
        }));
        userPoolId = poolResponse.UserPool!.Id!;

        await cognito.send(new CreateUserPoolDomainCommand({
          Domain: domainPrefix,
          UserPoolId: userPoolId,
        }));

        await new Promise(resolve => setTimeout(resolve, 5000));

        await cognito.send(new CreateResourceServerCommand({
          UserPoolId: userPoolId,
          Identifier: 'test-api',
          Name: 'Test API',
          Scopes: [{ ScopeName: 'read', ScopeDescription: 'Read access' }],
        }));

        const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
          UserPoolId: userPoolId,
          ClientName: 'ConcurrentTestClient',
          GenerateSecret: true,
          AllowedOAuthFlows: ['client_credentials'],
          AllowedOAuthScopes: ['test-api/read'],
          AllowedOAuthFlowsUserPoolClient: true,
        }));
        clientId = clientResponse.UserPoolClient!.ClientId!;
        clientSecret = clientResponse.UserPoolClient!.ClientSecret!;
      }

      const discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
      const providerName = `concurrent-provider-${Date.now()}`;
      const workloadName = `concurrent-workload-${Date.now()}`;

      try {
        await client.createOAuth2CredentialProvider({
          name: providerName,
          clientId,
          clientSecret,
          discoveryUrl,
        });

        await client.createWorkloadIdentity(workloadName);
        const workloadToken = await client.getWorkloadAccessTokenForUserId(workloadName, 'test-user');

        // Make 5 concurrent token requests
        const numRequests = 5;
        const promises = [];

        for (let i = 0; i < numRequests; i++) {
          promises.push(
            client.getOAuth2Token({
              providerName,
              scopes: ['test-api/read'],
              authFlow: 'M2M',
              workloadIdentityToken: workloadToken,
            })
          );
        }

        const tokens = await Promise.all(promises);

        expect(tokens).toHaveLength(numRequests);
        tokens.forEach(token => {
          expect(token).toBeDefined();
          expect(typeof token).toBe('string');
          expect(token.length).toBeGreaterThan(0);
        });
      } finally {
        // Cleanup AgentCore resources only (not Cognito pool)
        try { await client.deleteOAuth2CredentialProvider(providerName); } catch {}
        try { await client.deleteWorkloadIdentity(workloadName); } catch {}
      }
    });

    it('handles concurrent API key requests', async () => {
      const testSuffix = Date.now();
      const providerName = `concurrent-apikey-${testSuffix}`;
      const workloadName = `concurrent-apikey-workload-${testSuffix}`;

      try {
        // Setup
        await client.createApiKeyCredentialProvider({
          name: providerName,
          apiKey: 'sk-concurrent-test-key',
        });

        await client.createWorkloadIdentity(workloadName);
        const workloadToken = await client.getWorkloadAccessTokenForUserId(workloadName, 'test-user');

        // Make 5 concurrent API key requests
        const numRequests = 5;
        const promises = [];

        for (let i = 0; i < numRequests; i++) {
          promises.push(
            client.getApiKey({
              providerName,
              workloadIdentityToken: workloadToken,
            })
          );
        }

        const apiKeys = await Promise.all(promises);

        // Verify all requests succeeded
        expect(apiKeys).toHaveLength(numRequests);
        apiKeys.forEach(key => {
          expect(key).toBeDefined();
          expect(typeof key).toBe('string');
          expect(key).toBe('sk-concurrent-test-key');
        });

        // Cleanup
        await client.deleteApiKeyCredentialProvider(providerName);
        await client.deleteWorkloadIdentity(workloadName);
      } catch (e) {
        // Cleanup on error
        try {
          await client.deleteApiKeyCredentialProvider(providerName);
        } catch {}
        try {
          await client.deleteWorkloadIdentity(workloadName);
        } catch {}
        throw e;
      }
    });

    it('handles concurrent workload token requests', async () => {
      const testSuffix = Date.now();
      const workloadName = `concurrent-token-workload-${testSuffix}`;

      try {
        await client.createWorkloadIdentity(workloadName);

        // Make 5 concurrent workload token requests
        const numRequests = 5;
        const promises = [];

        for (let i = 0; i < numRequests; i++) {
          promises.push(
            client.getWorkloadAccessTokenForUserId(workloadName, `user-${i}`)
          );
        }

        const tokens = await Promise.all(promises);

        // Verify all requests succeeded
        expect(tokens).toHaveLength(numRequests);
        tokens.forEach(token => {
          expect(token).toBeDefined();
          expect(typeof token).toBe('string');
          expect(token.length).toBeGreaterThan(0);
        });

        // Cleanup
        await client.deleteWorkloadIdentity(workloadName);
      } catch (e) {
        try {
          await client.deleteWorkloadIdentity(workloadName);
        } catch {}
        throw e;
      }
    });
  });
});

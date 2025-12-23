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

describe('Identity Integration Tests', () => {
  const testIdentityName = `test-identity-${Date.now()}`;
  const testOAuth2ProviderName = `test-oauth2-${Date.now()}`;
  const testApiKeyProviderName = `test-apikey-${Date.now()}`;
  let client: IdentityClient;

  beforeAll(async () => {
    client = new IdentityClient(process.env.AWS_REGION || 'us-west-2');
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

  describe('HOF Wrappers', () => {
    it('should wrap function with withAccessToken', async () => {
      // Set region for wrapper's internal IdentityClient
      process.env.AWS_REGION = process.env.AWS_REGION || 'us-west-2';
      
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
      // Set region for wrapper's internal IdentityClient
      process.env.AWS_REGION = process.env.AWS_REGION || 'us-west-2';
      
      const wrappedFn = withApiKey({
        providerName: 'test-provider',
      })(async (input: string, apiKey: string) => {
        return { input, keyLength: apiKey.length };
      });

      expect(wrappedFn).toBeDefined();
      expect(typeof wrappedFn).toBe('function');
    });
  });

  describe('M2M OAuth2 Token Retrieval (Full Flow)', { timeout: 60000 }, () => {
    it('should complete full M2M flow with Cognito', async () => {
      // This test requires AWS Cognito permissions
      const { CognitoIdentityProviderClient, CreateUserPoolCommand, CreateResourceServerCommand, CreateUserPoolClientCommand, CreateUserPoolDomainCommand, DeleteUserPoolCommand } = await import('@aws-sdk/client-cognito-identity-provider');
      
      const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-west-2' });
      const testSuffix = Date.now();
      let userPoolId: string | undefined;
      let domainName: string | undefined;

      try {
        // 1. Create User Pool
        const poolResponse = await cognito.send(new CreateUserPoolCommand({
          PoolName: `AgentCoreM2MTest-${testSuffix}`,
        }));
        userPoolId = poolResponse.UserPool!.Id!;

        // 2. Create User Pool Domain
        domainName = `agentcore-m2m-${testSuffix}`;
        await cognito.send(new CreateUserPoolDomainCommand({
          Domain: domainName,
          UserPoolId: userPoolId,
        }));

        // Wait for domain to become active
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 3. Create Resource Server
        await cognito.send(new CreateResourceServerCommand({
          UserPoolId: userPoolId,
          Identifier: 'test-api',
          Name: 'Test API',
          Scopes: [
            { ScopeName: 'read', ScopeDescription: 'Read access' },
          ],
        }));

        // 4. Create App Client with client credentials grant
        const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
          UserPoolId: userPoolId,
          ClientName: 'M2MTestClient',
          GenerateSecret: true,
          AllowedOAuthFlows: ['client_credentials'],
          AllowedOAuthScopes: ['test-api/read'],
          AllowedOAuthFlowsUserPoolClient: true,
        }));
        const clientId = clientResponse.UserPoolClient!.ClientId!;
        const clientSecret = clientResponse.UserPoolClient!.ClientSecret!;

        // 5. Create AgentCore Identity OAuth2 provider
        const region = process.env.AWS_REGION || 'us-west-2';
        const discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
        const providerName = `test-m2m-provider-${testSuffix}`;
        
        await client.createOAuth2CredentialProvider({
          name: providerName,
          clientId,
          clientSecret,
          discoveryUrl,
        });

        // 6. Create workload identity
        const workloadName = `test-m2m-workload-${testSuffix}`;
        await client.createWorkloadIdentity(workloadName);
        const workloadToken = await client.getWorkloadAccessTokenForUserId(workloadName, 'test-user');

        // 7. Get OAuth2 token via M2M flow
        const token = await client.getOAuth2Token({
          providerName,
          scopes: ['test-api/read'],
          authFlow: 'M2M',
          workloadIdentityToken: workloadToken,
        });

        // Verify token
        expect(token).toBeDefined();
        expect(typeof token).toBe('string');
        expect(token.length).toBeGreaterThan(0);

        // Cleanup
        await client.deleteOAuth2CredentialProvider(providerName);
        await client.deleteWorkloadIdentity(workloadName);
      } finally {
        // Cleanup Cognito resources
        if (userPoolId) {
          const { DeleteUserPoolDomainCommand } = await import('@aws-sdk/client-cognito-identity-provider');
          try {
            // Delete domain first
            if (domainName) {
              await cognito.send(new DeleteUserPoolDomainCommand({
                Domain: domainName,
                UserPoolId: userPoolId,
              }));
            }
            // Then delete user pool
            await cognito.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId }));
          } catch (e) {
            console.warn('Failed to cleanup Cognito resources:', e);
          }
        }
      }
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

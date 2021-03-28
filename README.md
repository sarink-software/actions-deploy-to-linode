# actions-deploy-to-linode

## Overview

This action will take an artifact, scp it to a linode, untar it, and execute the deploy command. If the linode does not exist, it will be created and provisioned with the stackscript found in this repo. If the app has any subdomains, an A record for each one will be created and attached to the linode (this will happen on every deploy, so adding subdomains is easy, but it will never destroy A records). After the deploy, if the healthcheck fails, it will attempt to rollback to a previous version.

## Usage

```
jobs:
    name: Deploy
    runs-on: ubuntu-latest
    steps:
      - name: Checkout source
        uses: actions/checkout@v2

      - name: Create build artifact
        uses: sarink-software/actions-create-build-artifact@main
        id: build
        with:
          build-command: npm run build
          include: ./

      - name: Deploy to Linode
        uses: sarink-software/actions-deploy-to-linode@main
        with:
          app-env: prod
          linode-pat: ${{ secrets.LINODE_PAT }}
          linode-label: my-app.com
          domains: app.com,www.app.com
          email: admin@app.com
          deploy-artifact: ${{ steps.build.outputs.ARTIFACT_NAME }}
          deploy-command: docker-compose restart
          healthcheck-urls: app.com/healthcheck
          deploy-user-private-key: ${{ secrets.DEPLOY_USER_PRIVATE_KEY }}
          deploy-user-public-key: ${{ secrets.DEPLOY_USER_PUBLIC_KEY }}
          healthcheck-urls: app.com,www.app.com
```

## Required Inputs

`app-env`: The environment being deployed

`linode-pat`: A linode [personal access token](https://www.linode.com/docs/products/tools/linode-api/guides/get-access-token/) with scopes to read/write Domains and Linodes

`linode-label`: The label of the linode to deploy to (will be created if it does not exist)

`domains`: Comma-separated list of domains to connect to the linode (`A` records will be created for each one)

`email`: Administrator email address for this linode

`deploy-artifact`: The name of the github artifact to download and deploy (will be passed as the `name` param to the [download-artifact action](https://github.com/actions/download-artifact))

`deploy-command`: After the artifact is copied to the server, this script will run (as the `deploy-user`) to launch your app

`deploy-user-private-key`: Private key for the deploy user. Should be kept secret.

`deploy-user-public-key`: Public key for the deploy user. If this action creates the linode, this key will automatically be added to the `authorized_keys` list on the server. Otherwise, you will have to add it yourself.

## Optional Inputs

`linode-root-pass`: If this action creates the linode, set this value as the root password. Otherwise, linode itself will auto-generate a root password (either way, you will be able to modify this later by logging into the linode UI)

`linode-admin-users-file`: If this action creates the linode, create each of these users on the server (they will be added to the admin, dev, wheel groups, see the [stackscript](https://github.com/sarink-software/actions-deploy-to-linode/blob/main/stackscript.sh) for more details) and add their public keys.

Example: `linode-admin-users-file: ./admin_users.json` with contents:

```
[
  {
    "user": "admin",
    "public_key": "ssh-rsa abc123mypublickey=="
  },
  ...
]
```

`deploy-user`: The name of the deploy user on the server (should correspond with the `deploy-user-public/private-key` variables). Default: `deploy`

`healthcheck-urls`: After deploying, the app will wait for this url to return an http 200. If it does not succeed after 30 seconds, it will roll back the previous code, and attempt to restart the old version by re-execting `deploy-command` (note that at this time it will run the _new_ `deploy-command` which may cause problems if you've changed it and your deploy fails)

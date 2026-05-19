output "public_ip" {
  description = "Elastic IP of the Burble host."
  value       = aws_eip.burble.public_ip
}

output "nip_io_domain" {
  description = "HTTPS hostname to use for BASE_URL and the GitHub OAuth callback."
  value       = local.nip_io_domain
}

output "instance_id" {
  description = "EC2 instance ID. Use it as the SSM target."
  value       = aws_instance.burble.id
}

output "ssm_command" {
  description = "Open an interactive shell on the host."
  value       = "aws ssm start-session --target ${aws_instance.burble.id}"
}

output "ssm_transfer_bucket_name" {
  description = "S3 bucket used by Ansible's aws_ssm connection plugin."
  value       = aws_s3_bucket.ssm_transfer.bucket
}

output "github_oauth_callback_url" {
  description = "Register this callback URL on the GitHub OAuth app."
  value       = "https://${local.nip_io_domain}/oauth/github/callback"
}

output "next_steps" {
  description = "Manual steps to complete the deployment."
  value       = <<-EOT

    Next steps:

      1. Set the GitHub OAuth callback URL:
         https://${local.nip_io_domain}/oauth/github/callback

      2. Open a shell on the host via SSM:
         aws ssm start-session --target ${aws_instance.burble.id}

      3. Clone the repo and configure compose:
         sudo -u ubuntu bash
         cd ~
         git clone <this repo url> burble
         cd burble/deploy/dev/compose
         cp .env.example .env
         vi .env
         # DOMAIN=${local.nip_io_domain}
         # set SLACK_* and GITHUB_* secrets

      4. Bring up the stack:
         docker compose up -d --build
         docker compose logs -f

      5. Verify:
         curl -fsSL https://${local.nip_io_domain}/healthz   ->   ok
  EOT
}

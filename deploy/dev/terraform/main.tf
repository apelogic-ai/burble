/**
 * Burble — dev deployment on AWS.
 *
 * Resources:
 *   - EC2 t4g.small (ARM, Ubuntu 24.04) running Docker + Docker Compose.
 *   - Elastic IP so the nip.io hostname remains stable across restarts.
 *   - Security group: 80 + 443 from anywhere, no SSH.
 *   - IAM role for AWS Systems Manager Session Manager.
 *   - Private S3 bucket used by Ansible's aws_ssm connection plugin to
 *     transfer files during deployment.
 *
 * The app stack is deployed separately by the Ansible playbook or manually
 * from deploy/dev/compose.
 */

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  nip_io_domain = "${aws_eip.burble.public_ip}.nip.io"
}

resource "aws_s3_bucket" "ssm_transfer" {
  bucket = var.ssm_transfer_bucket_name
  tags = {
    Name        = var.ssm_transfer_bucket_name
    Environment = "dev"
    Project     = "burble"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ssm_transfer" {
  bucket = aws_s3_bucket.ssm_transfer.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "ssm_transfer" {
  bucket                  = aws_s3_bucket.ssm_transfer.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "burble" {
  name               = "${var.name_prefix}-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

data "aws_iam_policy_document" "ssm_transfer_rw" {
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.ssm_transfer.arn,
      "${aws_s3_bucket.ssm_transfer.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "ssm_transfer_rw" {
  name   = "ssm-transfer-rw"
  role   = aws_iam_role.burble.id
  policy = data.aws_iam_policy_document.ssm_transfer_rw.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.burble.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "burble" {
  name = "${var.name_prefix}-host"
  role = aws_iam_role.burble.name
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "burble" {
  name        = "${var.name_prefix}-host"
  description = "burble dev host: https/http from world; shell access via SSM"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "http (Caddy ACME challenge + redirect)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "https (Burble OAuth callback)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "all outbound (GitHub, Slack, package mirrors, ACME, SSM)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_ami" "ubuntu_arm64" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_instance" "burble" {
  ami                    = data.aws_ami.ubuntu_arm64.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.burble.id]
  iam_instance_profile   = aws_iam_instance_profile.burble.name
  user_data              = file("${path.module}/user-data.sh")

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 30
    encrypted   = true
  }

  tags = {
    Name        = "${var.name_prefix}-host"
    Environment = "dev"
    Project     = "burble"
  }
}

resource "aws_eip" "burble" {
  domain   = "vpc"
  instance = aws_instance.burble.id
  tags = {
    Name = "${var.name_prefix}-host"
  }
}

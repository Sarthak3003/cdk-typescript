import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as rds from 'aws-cdk-lib/aws-rds';

export class AWSstack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //
    // 1. VPC の作成: パブリックサブネット(2つ), プライベートサブネット(2つ) を想定
    //
    const vpc = new ec2.Vpc(this, 'MyAppVPC', {
      cidr: '10.0.0.0/16',
      maxAzs: 2, // 2 つの AZ を使用
      natGateways: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PrivateSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }
      ]
    });

    //
    // 2. Security Group の作成
    //
    // ALB 用 SG (80番ポートでインターネットからアクセスを受け付け)
    const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for ALB',
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from Internet');

    // EC2(WordPress) 用 SG (ALB から 80 番ポートでアクセスを受け付ける)
    const ec2SecurityGroup = new ec2.SecurityGroup(this, 'EC2SecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for EC2 in private subnet',
    });
    ec2SecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(80), 'Allow HTTP from ALB');

    // RDS 用 SG (EC2 から 3306 番ポートでアクセスを許可)
    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RDSSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for RDS in private subnet',
    });
    rdsSecurityGroup.addIngressRule(ec2SecurityGroup, ec2.Port.tcp(3306), 'Allow MySQL access from EC2');

    //
    // 3. Secrets Manager の Secret 作成 (RDS パスワードを安全に管理する)
    //
    const dbSecret = new secretsmanager.Secret(this, 'DBSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    //
    // 4. RDS の作成 (Multi-AZ MySQL)
    //
    const dbSubnetGroup = new rds.SubnetGroup(this, 'DBSubnetGroup', {
      vpc,
      description: 'Subnet group for RDS',
      subnetGroupName: 'PrivateSubnetGroup',
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dbInstance = new rds.DatabaseInstance(this, 'MyRDSInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      credentials: rds.Credentials.fromSecret(dbSecret),
      multiAz: true,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      securityGroups: [rdsSecurityGroup],
      subnetGroup: dbSubnetGroup,
      publiclyAccessible: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 実運用では RETAIN を推奨
      deletionProtection: false,                // 実運用では true を推奨
      databaseName: 'wordpressdb',
    });

    //
    // 5. ALB の作成
    //
    const alb = new elb.ApplicationLoadBalancer(this, 'MyALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      loadBalancerName: 'MyWordPressALB',
    });

    //
    // 6. IAM ロール (EC2 インスタンス用)
    //
    // SSM Session Manager などを利用したい場合にポリシーを追加
    const ec2Role = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Role for EC2 instances',
    });
    ec2Role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    //
    // 7. AutoScaling Group (EC2 WordPress 用)
    //    Amazon Linux 2 をベースに User Data で WordPress をインストールする例
    //
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      '# 1. パッケージの更新',
      'yum update -y',

      '# 2. Apache HTTPサーバーのインストールと自動起動設定',
      'yum install -y httpd',
      'systemctl enable httpd',
      'systemctl start httpd',

      '# 3. "Hello World" を返す単純なHTMLファイル作成',
      'echo "<html><h1>Hello World</h1></html>" > /var/www/html/index.html',

      '# 4. (任意) パーミッションや所有者設定の整備',
      'chown apache:apache /var/www/html/index.html',
      'chmod 644 /var/www/html/index.html'
    );

    const asg = new autoscaling.AutoScalingGroup(this, 'WordPressASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux(),
      role: ec2Role,
      securityGroup: ec2SecurityGroup,
      desiredCapacity: 2,
      minCapacity: 2,
      maxCapacity: 4,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      userData: userData,
    });

    //
    // 8. ALB リスナー & ターゲットグループの設定
    //
    const listener = alb.addListener('HTTPListener', {
      port: 80,
      open: true,
    });

    listener.addTargets('WordPressFleet', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });

    //
    // 9. 出力情報
    //
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      description: 'DNS Name of the ALB',
      value: alb.loadBalancerDnsName,
    });
    new cdk.CfnOutput(this, 'DBEndpoint', {
      description: 'Endpoint of the RDS DB',
      value: dbInstance.dbInstanceEndpointAddress,
    });
  }
}